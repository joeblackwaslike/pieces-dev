import type { RearmHandle, WatchdogDeps } from './deps.js';

/** Process-name matcher for the headless Pieces OS service. */
const PIECES_MATCHER = 'Pieces OS';
/** How often `waitForStartup` re-polls health. */
const STARTUP_POLL_MS = 1_000;

export interface WatchdogSnapshot {
	restartCount: number;
	healthFailStreak: number;
	authLoggedIn: boolean;
	lastCleanTime: number;
	escalating: boolean;
	gaveUp: boolean;
	paused: boolean;
}

type Tier = 'api' | 'sigterm' | 'sigkill';

/**
 * The watchdog finite-state machine, ported from `pieces_babysitter.py`. It owns
 * no I/O of its own — every side effect goes through the injected {@link WatchdogDeps},
 * so each branch is a deterministic unit test.
 */
export class WatchdogEngine {
	private startupTime: number;
	private escalating = false;
	private paused = false;
	private restartCount: number;
	private healthFailStreak = 0;
	private lastCleanTime: number;
	private authLoggedIn: boolean;
	private gaveUp: boolean;
	private gaveUpAt: number;
	private rearmHandle: RearmHandle | null = null;

	/** The in-flight escalation, exposed so the tick (and shutdown) can await it. */
	pendingEscalation: Promise<void> | null = null;

	constructor(private readonly deps: WatchdogDeps) {
		const persisted = deps.persist.load();
		this.restartCount = persisted.restartCount;
		this.lastCleanTime = persisted.lastCleanTime;
		this.authLoggedIn = persisted.authLoggedIn;
		this.gaveUp = persisted.gaveUp;
		this.gaveUpAt = persisted.gaveUpAt;
		this.startupTime = deps.now();
	}

	snapshot(): WatchdogSnapshot {
		return {
			restartCount: this.restartCount,
			healthFailStreak: this.healthFailStreak,
			authLoggedIn: this.authLoggedIn,
			lastCleanTime: this.lastCleanTime,
			escalating: this.escalating,
			gaveUp: this.gaveUp,
			paused: this.paused,
		};
	}

	// ── Health ──────────────────────────────────────────────────────────────

	async healthTick(): Promise<void> {
		const s = this.deps.settings();

		// Lazy restart-counter reset: clean uptime since the last restart attempt.
		if (
			this.restartCount > 0 &&
			this.deps.now() - this.lastCleanTime > s.cleanUptimeResetSec * 1000
		) {
			this.restartCount = 0;
			this.deps.persist.save({ restartCount: 0 });
			this.deps.log.info('clean uptime — restart counter reset');
		}

		if (this.escalating || this.paused || this.gaveUp) return;

		const pids = this.deps.process.listPids(PIECES_MATCHER);
		const inGrace = this.deps.now() - this.startupTime < s.startupGraceSec * 1000;

		// Duplicate instance — the DB-wipe class of failure.
		if (pids.length > 1) {
			this.deps.incidents.record({
				kind: 'duplicate-instance',
				severity: 'crit',
				summary: `${pids.length} Pieces OS instances running — killing duplicates`,
				data: { count: pids.length, pids },
			});
			await this.deps.process.killPieces('term');
			await this.deps.process.launchPieces();
			this.deps.bus.emit('watchdog.duplicate-killed', { count: pids.length, pids });
			this.deps.health.report('pieces-os', 'warn', 'duplicate instance killed');
			return;
		}

		// Missing instance — relaunch (cheap recovery), unless still in startup grace.
		if (pids.length === 0) {
			if (inGrace) {
				this.deps.health.report('pieces-os', 'warn', 'starting');
				return;
			}
			this.deps.incidents.record({
				kind: 'process-missing',
				severity: 'warn',
				summary: 'Pieces OS not running — relaunching',
				data: { grace: false },
			});
			await this.deps.process.launchPieces();
			this.deps.health.report('pieces-os', 'warn', 'relaunched (was missing)');
			return;
		}

		const healthy = await this.deps.pieces.checkHealth();
		if (healthy) {
			this.healthFailStreak = 0;
			this.deps.health.report('pieces-os', 'ok');
			return;
		}

		if (inGrace) {
			this.healthFailStreak = 0;
			this.deps.health.report('pieces-os', 'warn', 'startup grace');
			return;
		}

		this.healthFailStreak++;
		if (this.healthFailStreak >= s.healthFailLimit) {
			this.deps.incidents.record({
				kind: 'pieces-health-fail',
				severity: 'warn',
				summary: `Health check failed ${this.healthFailStreak}× — escalating restart`,
				data: { streak: this.healthFailStreak },
			});
			this.deps.health.report('pieces-os', 'warn', 'escalating');
			this.dispatchEscalation();
			return;
		}
		this.deps.health.report(
			'pieces-os',
			'warn',
			`health failing ${this.healthFailStreak}/${s.healthFailLimit}`,
		);
	}

	/** Fire-and-return: the escalation runs detached so the tick never blocks. */
	private dispatchEscalation(): void {
		if (this.escalating || this.paused) return;
		this.pendingEscalation = this.escalate().finally(() => {
			this.pendingEscalation = null;
		});
	}

	// ── Escalation ──────────────────────────────────────────────────────────

	async escalate(): Promise<void> {
		if (this.escalating || this.paused) return;
		this.escalating = true;
		try {
			const s = this.deps.settings();
			this.restartCount++;
			this.lastCleanTime = this.deps.now();
			this.deps.persist.save({
				restartCount: this.restartCount,
				lastCleanTime: this.lastCleanTime,
			});
			this.deps.bus.emit('watchdog.restarting', { attempt: this.restartCount });

			if (this.restartCount > s.maxRestarts) {
				this.giveUp(s);
				return;
			}

			const base = this.deps.pieces.baseUrl();
			let succeeded = false;
			let tier: Tier = 'api';

			succeeded = await this.tierApi(base, s);
			this.recordAttempt('api', succeeded);

			if (!succeeded) {
				tier = 'sigterm';
				succeeded = await this.tierKill('term', s);
				this.recordAttempt('sigterm', succeeded);
			}
			if (!succeeded) {
				tier = 'sigkill';
				succeeded = await this.tierKill('kill', s);
				this.recordAttempt('sigkill', succeeded);
			}

			if (succeeded) {
				this.healthFailStreak = 0;
				this.deps.incidents.record({
					kind: 'restart-succeeded',
					severity: 'info',
					summary: `Pieces OS recovered via ${tier} restart`,
					data: { attempt: this.restartCount, tier },
				});
				this.deps.bus.emit('watchdog.restarted', { attempt: this.restartCount, tier });
				this.deps.health.report('pieces-os', 'ok', 'restarted');
			} else {
				this.deps.health.report('pieces-os', 'crit', 'all restart tiers failed');
			}
		} finally {
			this.escalating = false;
		}
	}

	private recordAttempt(tier: Tier, succeeded: boolean): void {
		this.deps.incidents.record({
			kind: 'restart-attempt',
			severity: succeeded ? 'info' : 'warn',
			summary: `Restart attempt ${this.restartCount} via ${tier}: ${succeeded ? 'ok' : 'failed'}`,
			data: { attempt: this.restartCount, tier, outcome: succeeded ? 'ok' : 'failed' },
		});
	}

	private async tierApi(base: string | null, s: ReturnType<WatchdogDeps['settings']>): Promise<boolean> {
		if (!base) return false;
		try {
			await this.deps.httpPost(`${base}/os/restart`);
		} catch {
			// A failed POST just means we fall through to the harder tiers.
		}
		await this.deps.sleep(s.restartWaitSec * 1000);
		return this.deps.pieces.checkHealth();
	}

	private async tierKill(
		signal: 'term' | 'kill',
		s: ReturnType<WatchdogDeps['settings']>,
	): Promise<boolean> {
		await this.deps.process.killPieces(signal);
		await this.deps.process.launchPieces();
		return this.waitForStartup(s.startupWaitTimeoutSec);
	}

	private async waitForStartup(timeoutSec: number): Promise<boolean> {
		const deadline = this.deps.now() + timeoutSec * 1000;
		while (true) {
			if (await this.deps.pieces.checkHealth()) return true;
			if (this.deps.now() >= deadline) return false;
			await this.deps.sleep(STARTUP_POLL_MS);
		}
	}

	private giveUp(s: ReturnType<WatchdogDeps['settings']>): void {
		this.gaveUp = true;
		this.gaveUpAt = this.deps.now();
		this.deps.persist.save({ gaveUp: true, gaveUpAt: this.gaveUpAt });
		this.deps.notify.notify({
			title: 'Pieces OS — CRITICAL',
			body: 'Pieces OS could not be recovered after repeated restarts. It is no longer being supervised until you intervene.',
			severity: 'crit',
			dedupKey: 'watchdog.gave-up',
			action: { type: 'deep-link', route: '/watchdog' },
		});
		this.deps.health.report('pieces-os', 'crit', 'gave up — restart budget exhausted');
		this.deps.incidents.record({
			kind: 'gave-up',
			severity: 'crit',
			summary: `Gave up after ${this.restartCount} restarts (max ${s.maxRestarts})`,
			data: { restartCount: this.restartCount, maxRestarts: s.maxRestarts },
		});
		this.deps.bus.emit('watchdog.gave-up', { restartCount: this.restartCount });

		if (s.gaveUpCooloffSec > 0) {
			this.rearmHandle = this.deps.scheduleRearm(s.gaveUpCooloffSec * 1000, () => this.rearm());
		}
	}

	private rearm(): void {
		this.restartCount = 0;
		this.gaveUp = false;
		this.gaveUpAt = 0;
		this.rearmHandle = null;
		this.deps.persist.save({ restartCount: 0, gaveUp: false, gaveUpAt: 0 });
		this.deps.log.info('watchdog auto-rearmed after cooloff');
	}

	/** Manual un-latch (the `watchdog.reset` command). */
	reset(): void {
		this.restartCount = 0;
		this.healthFailStreak = 0;
		this.gaveUp = false;
		this.gaveUpAt = 0;
		this.rearmHandle?.cancel();
		this.rearmHandle = null;
		this.deps.persist.save({ restartCount: 0, gaveUp: false, gaveUpAt: 0 });
	}

	// ── Auth ────────────────────────────────────────────────────────────────

	async authTick(): Promise<void> {
		const loggedIn = await this.fetchLoggedIn();
		const was = this.authLoggedIn;
		this.deps.health.report('pieces-auth', loggedIn ? 'ok' : 'warn');

		if (was && !loggedIn) {
			this.authLoggedIn = false;
			this.deps.persist.save({ authLoggedIn: false });
			this.deps.incidents.record({
				kind: 'auth-lost',
				severity: 'warn',
				summary: 'Pieces is logged out — long-term memory capture has stopped',
			});
			this.deps.notify.notify({
				title: 'Pieces OS — Auth Lost',
				body: 'Pieces is logged out. LTM may have stopped collecting. Open the app to re-login.',
				severity: 'warn',
				dedupKey: 'watchdog.auth-lost',
				action: { type: 'deep-link', route: '/watchdog' },
			});
			await this.deps.process.openApp();
			this.deps.bus.emit('watchdog.auth-lost');
		} else if (!was && loggedIn) {
			this.authLoggedIn = true;
			this.deps.persist.save({ authLoggedIn: true });
			this.deps.incidents.record({
				kind: 'auth-restored',
				severity: 'info',
				summary: 'Pieces is logged back in — LTM is running',
			});
			this.deps.notify.notify({
				title: 'Pieces OS — Auth Restored',
				body: 'Pieces is logged back in. LTM is running.',
				severity: 'info',
				dedupKey: 'watchdog.auth-restored',
			});
			this.deps.bus.emit('watchdog.auth-restored');
		} else if (!loggedIn) {
			this.deps.log.info('auth check: still logged out');
		}
	}

	private async fetchLoggedIn(): Promise<boolean> {
		const base = this.deps.pieces.baseUrl();
		if (!base) return false;
		try {
			const res = await this.deps.httpGet(`${base}/user`);
			if (res.status !== 200) return false;
			const data = JSON.parse(res.body) as Record<string, unknown>;
			const user = (data?.user ?? data) as Record<string, unknown> | undefined;
			return !!(user && (user.id || user.email));
		} catch {
			return false;
		}
	}

	// ── Boot launch ─────────────────────────────────────────────────────────

	async bootLaunch(): Promise<void> {
		const s = this.deps.settings();
		if (!s.manageBootLaunch) return;
		this.startupTime = this.deps.now();
		await this.deps.process.killPieces('term');
		await this.deps.process.launchPieces();
		const ok = await this.waitForStartup(s.startupGraceSec);
		if (ok) {
			this.lastCleanTime = this.deps.now();
			this.deps.persist.save({ lastCleanTime: this.lastCleanTime });
			this.deps.health.report('pieces-os', 'ok', 'launched at boot');
		} else {
			this.deps.incidents.record({
				kind: 'startup-unhealthy',
				severity: 'warn',
				summary: 'Pieces OS did not become healthy within the startup grace window',
				data: { graceSec: s.startupGraceSec },
			});
			this.deps.health.report('pieces-os', 'warn', 'startup unhealthy');
		}
	}

	// ── On-demand actions (commands) ──────────────────────────────────────────

	/** Force a full kill + relaunch of Pieces OS (the `watchdog.relaunch` command). */
	async relaunch(): Promise<void> {
		await this.deps.process.killPieces('term');
		await this.deps.process.launchPieces();
	}

	/** Kill duplicate instances and leave exactly one running. Returns the count found. */
	async killDuplicates(): Promise<number> {
		const pids = this.deps.process.listPids(PIECES_MATCHER);
		if (pids.length > 1) {
			this.deps.incidents.record({
				kind: 'duplicate-instance',
				severity: 'crit',
				summary: `${pids.length} Pieces OS instances running — killing duplicates`,
				data: { count: pids.length, pids },
			});
			await this.deps.process.killPieces('term');
			await this.deps.process.launchPieces();
			this.deps.bus.emit('watchdog.duplicate-killed', { count: pids.length, pids });
		}
		return pids.length;
	}

	// ── Doctor restore standby ────────────────────────────────────────────────

	onRestoreBegin(payload: { restoreId?: string } = {}): void {
		this.paused = true;
		this.deps.bus.emit('watchdog.standby-ack', { restoreId: payload.restoreId });
	}

	onRestoreEnd(): void {
		this.paused = false;
	}
}
