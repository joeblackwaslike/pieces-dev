import type { HealthState, Severity } from '@pieces-dev/monitor-sdk';
import { canAutoPin } from './baseline.js';
import type { DataIntegrityDeps } from './deps.js';
import type { DataIntegritySettings } from './settings.js';
import {
	evalFreshness,
	evalIntegrity,
	evalLatency,
	evalSeqno,
	evalSizeCollapse,
	evalWal,
	worst,
} from './signals.js';
import type { Baseline, DbConfig, DbSample, SuspectReason } from './types.js';

type SignalName = 'collapse' | 'corruption' | 'wal' | 'freshness' | 'latency' | 'missing';
type SignalStates = Record<SignalName, HealthState>;

const OK_SIGNALS = (): SignalStates => ({
	collapse: 'ok',
	corruption: 'ok',
	wal: 'ok',
	freshness: 'ok',
	latency: 'ok',
	missing: 'ok',
});

const RANK: Record<HealthState, number> = { ok: 0, warn: 1, crit: 2 };

/** Map a health state to an incident severity (`ok` shouldn't reach an incident, but map it safely). */
const severityOf = (state: HealthState): Severity => (state === 'ok' ? 'info' : state);

export interface DbReport {
	id: string;
	status: HealthState;
	suspect: boolean;
	sample: DbSample | null;
}

/**
 * The data-integrity sweep engine. On each sweep it stats + probes every
 * configured database, evaluates the six signals against the persisted baseline
 * and prior sample, and raises incidents / notifications / bus events on state
 * transitions only. All I/O is injected ({@link DataIntegrityDeps}).
 */
export class DataIntegrityEngine {
	private readonly prevSignals = new Map<string, SignalStates>();
	private readonly suspect = new Map<string, boolean>();
	private readonly lastIntegrityAt = new Map<string, number>();
	private readonly lastAdvance = new Map<string, { seqno: number; at: number }>();
	private readonly lastStatus = new Map<string, HealthState>();

	constructor(private readonly deps: DataIntegrityDeps) {
		// Seed the freshness clock from history so a daemon restart doesn't reset age to 0.
		const source = deps.settings().freshnessSource;
		const latest = deps.history.latest(source.dbId);
		if (latest && latest.maxSeqno !== null) {
			this.lastAdvance.set(source.dbId, { seqno: latest.maxSeqno, at: latest.ts });
		}
	}

	snapshot(): Array<{ id: string; status: HealthState; suspect: boolean }> {
		return [...this.lastStatus.entries()].map(([id, status]) => ({
			id,
			status,
			suspect: this.suspect.get(id) ?? false,
		}));
	}

	/** Operator "pin current state as known-good" (the baseline-pending one-click confirm). */
	pinBaseline(id: string): boolean {
		const last = this.deps.history.latest(id);
		if (!last) return false;
		this.deps.baseline.pin({
			id,
			baselineBytes: last.bytes,
			baselineMaxSeqno: last.maxSeqno,
			baselineCount: last.count,
			pinnedAt: this.deps.now(),
			pinnedReason: 'operator-ack',
		});
		return true;
	}

	async sweep(opts: { deep?: boolean; onlyId?: string } = {}): Promise<DbReport[]> {
		const s = this.deps.settings();
		const gateActive =
			(await this.deps.piecesHealthy()) &&
			(await this.deps.piecesAuthed()) &&
			this.deps.idleSeconds() <= s.userIdleSec;
		const authed = await this.deps.piecesAuthed();

		let sweepOk = true;
		const reports: DbReport[] = [];
		for (const db of s.databases) {
			if (!db.enabled) continue;
			if (opts.onlyId && db.id !== opts.onlyId) continue;
			try {
				reports.push(await this.sweepDb(db, s, gateActive, authed, opts.deep ?? false));
			} catch (err) {
				sweepOk = false;
				this.deps.log.error(`sweep failed for ${db.id}`, err);
			}
		}
		this.deps.health.report('data.sweep', sweepOk ? 'ok' : 'crit', sweepOk ? undefined : 'sweep error');
		return reports;
	}

	private async sweepDb(
		db: DbConfig,
		s: DataIntegritySettings,
		gateActive: boolean,
		authed: boolean,
		forceDeep: boolean,
	): Promise<DbReport> {
		const checkId = `data.${db.id}`;
		const files = this.deps.expandGlob(s.dataDir, db.glob).filter((f) => this.deps.statFile(f).exists);

		// Missing — a previously-baselined critical DB with no files on disk.
		if (files.length === 0) {
			const seen = this.deps.baseline.load(db.id) !== null;
			if (db.critical && seen) {
				this.transitionMissing(db);
				this.deps.health.report(checkId, 'crit', 'missing');
				this.lastStatus.set(db.id, 'crit');
				return { id: db.id, status: 'crit', suspect: true, sample: null };
			}
			this.prevSignals.set(db.id, OK_SIGNALS());
			this.deps.health.report(checkId, 'ok', 'absent');
			this.lastStatus.set(db.id, 'ok');
			return { id: db.id, status: 'ok', suspect: false, sample: null };
		}

		const sized = files.map((f) => ({ path: f, bytes: this.deps.statFile(f).bytes }));
		const bytes = sized.reduce((a, b) => a + b.bytes, 0);
		const wal = files.reduce(
			(acc, f) => {
				const w = this.deps.walInfo(f);
				return { walBytes: acc.walBytes + w.walBytes, shmPresent: acc.shmPresent || w.shmPresent };
			},
			{ walBytes: 0, shmPresent: false },
		);
		const target = sized.reduce((a, b) => (b.bytes > a.bytes ? b : a)).path;

		const isSource = s.freshnessSource.dbId === db.id;
		const wantDeep =
			forceDeep ||
			this.deps.now() - (this.lastIntegrityAt.get(db.id) ?? Number.NEGATIVE_INFINITY) >=
				s.integrityCheckIntervalSec * 1000;
		const pr = this.deps.probe(target, {
			table: isSource ? s.freshnessSource.table : undefined,
			deepIntegrity: wantDeep,
			now: () => this.deps.now(),
		});
		if (wantDeep) this.lastIntegrityAt.set(db.id, this.deps.now());

		const prev = this.deps.history.latest(db.id);
		const ageMinutes = isSource ? this.computeAge(db.id, pr.maxSeqno) : null;

		const integrity = pr.integrity ? evalIntegrity(pr.integrity) : { state: 'ok' as HealthState, corrupt: false };
		const fresh = evalFreshness(ageMinutes, gateActive, s.freshnessWarnMinutes, s.freshnessCritMinutes);

		// First-run baseline bootstrap.
		let base: Baseline | null = this.deps.baseline.load(db.id);
		if (!base) {
			const mayPin = canAutoPin({
				bytes,
				integrityCrit: integrity.corrupt,
				freshnessCrit: fresh.state === 'crit',
				piecesAuthed: authed,
			});
			if (mayPin) {
				base = this.deps.baseline.ratchet(db.id, bytes, pr.maxSeqno, pr.count, this.deps.now());
			} else {
				this.deps.health.report(checkId, 'warn', 'baseline-pending');
				this.lastStatus.set(db.id, 'warn');
				this.appendSample(db.id, bytes, wal, pr, ageMinutes, 'warn');
				if (isSource) this.emitFreshness(db.id, ageMinutes, pr.maxSeqno);
				return { id: db.id, status: 'warn', suspect: false, sample: null };
			}
		}

		const collapse = evalSizeCollapse(bytes, base.baselineBytes, s.collapseRatio, s.minCollapseBytes);
		const seqno = isSource
			? evalSeqno(pr.maxSeqno, pr.count, prev?.maxSeqno ?? null, prev?.count ?? null)
			: { suspect: false };
		const corruptionCrit = integrity.corrupt || seqno.suspect;
		const walGrowing = prev ? wal.walBytes > prev.walBytes && bytes <= prev.bytes : false;
		const walSig = evalWal(wal.walBytes, s.walWarnBytes, s.walCritBytes, walGrowing);
		const latSig = evalLatency(pr.latencyMs, s.latencyWarnMs, s.latencyCritMs);

		const signals: SignalStates = {
			collapse: collapse.collapsed ? 'crit' : 'ok',
			corruption: corruptionCrit ? 'crit' : 'ok',
			wal: walSig.state,
			freshness: fresh.state,
			latency: latSig.state,
			missing: 'ok',
		};
		const status = worst(Object.values(signals));

		// Ratchet the baseline up only on healthy growth.
		if (!collapse.collapsed && !corruptionCrit && bytes > base.baselineBytes) {
			this.deps.baseline.ratchet(db.id, bytes, pr.maxSeqno, pr.count, this.deps.now());
		}

		this.handleTransitions(db, signals, {
			bytes,
			base,
			collapse: collapse.dropRatio,
			integrity: pr.integrity,
			maxSeqno: pr.maxSeqno,
			ageMinutes,
			walBytes: wal.walBytes,
			mainBytes: bytes,
			shmPresent: wal.shmPresent,
			latencyMs: pr.latencyMs,
			latencyThreshold: s.latencyCritMs,
		});

		const isSuspectNow = collapse.collapsed || corruptionCrit;
		this.updateSuspect(db.id, isSuspectNow, collapse.collapsed ? 'collapse' : 'corruption', status);

		if (isSource) this.emitFreshness(db.id, ageMinutes, pr.maxSeqno);

		this.deps.health.report(checkId, status, this.detail(bytes, base.baselineBytes, ageMinutes, pr.latencyMs));
		this.appendSample(db.id, bytes, wal, pr, ageMinutes, status);
		this.lastStatus.set(db.id, status);
		return { id: db.id, status, suspect: isSuspectNow, sample: this.deps.history.latest(db.id) };
	}

	private computeAge(id: string, maxSeqno: number | null): number | null {
		if (maxSeqno === null) return null;
		const now = this.deps.now();
		const prev = this.lastAdvance.get(id);
		if (!prev || maxSeqno > prev.seqno) {
			this.lastAdvance.set(id, { seqno: maxSeqno, at: now });
			return 0;
		}
		return (now - prev.at) / 60_000;
	}

	private emitFreshness(id: string, ageMinutes: number | null, maxSeqno: number | null): void {
		this.deps.bus.emit('data-integrity.freshness', { id, ageMinutes, maxSeqno, at: this.deps.now() });
	}

	private appendSample(
		id: string,
		bytes: number,
		wal: { walBytes: number; shmPresent: boolean },
		pr: { maxSeqno: number | null; count: number | null; latencyMs: number; integrity: string | null },
		ageMinutes: number | null,
		status: HealthState,
	): void {
		this.deps.history.append({
			id,
			ts: this.deps.now(),
			bytes,
			walBytes: wal.walBytes,
			shmPresent: wal.shmPresent,
			maxSeqno: pr.maxSeqno,
			count: pr.count,
			ageMinutes,
			latencyMs: pr.latencyMs,
			integrity: pr.integrity,
			status,
		});
	}

	private detail(bytes: number, baselineBytes: number, ageMinutes: number | null, latencyMs: number): string {
		const parts = [`${(bytes / 1_048_576).toFixed(1)}MB/${(baselineBytes / 1_048_576).toFixed(1)}MB`];
		if (ageMinutes !== null) parts.push(`age ${ageMinutes.toFixed(0)}m`);
		parts.push(`${latencyMs.toFixed(0)}ms`);
		return parts.join(' · ');
	}

	private worsened(id: string, name: SignalName, current: HealthState): boolean {
		const prev = this.prevSignals.get(id) ?? OK_SIGNALS();
		return RANK[current] > RANK[prev[name]] && current !== 'ok';
	}

	private handleTransitions(
		db: DbConfig,
		signals: SignalStates,
		ctx: {
			bytes: number;
			base: Baseline;
			collapse: number;
			integrity: string | null;
			maxSeqno: number | null;
			ageMinutes: number | null;
			walBytes: number;
			mainBytes: number;
			shmPresent: boolean;
			latencyMs: number;
			latencyThreshold: number;
		},
	): void {
		const id = db.id;
		const deepLink = { type: 'deep-link' as const, route: `/ext/doctor?db=${id}` };

		if (this.worsened(id, 'collapse', signals.collapse)) {
			this.deps.incidents.record({
				kind: 'size-collapse',
				severity: 'crit',
				summary: `${id} collapsed ${(ctx.collapse * 100).toFixed(0)}% below baseline`,
				data: { id, bytes: ctx.bytes, baselineBytes: ctx.base.baselineBytes, dropRatio: ctx.collapse, baselinePinnedAt: ctx.base.pinnedAt },
			});
			this.deps.notify.notify({
				title: 'Pieces data — Size Collapse',
				body: `${id} shrank far below its known-good size. LTM data may have been lost.`,
				severity: 'crit',
				dedupKey: `data-integrity.collapse.${id}`,
				action: deepLink,
			});
		}

		if (this.worsened(id, 'corruption', signals.corruption)) {
			this.deps.incidents.record({
				kind: 'corruption-suspected',
				severity: 'crit',
				summary: `${id} failed an integrity / sequence check`,
				data: { id, integrityCheckOutput: ctx.integrity, maxSeqno: ctx.maxSeqno },
			});
			this.deps.notify.notify({
				title: 'Pieces data — Corruption Suspected',
				body: `${id} failed an integrity check.`,
				severity: 'crit',
				dedupKey: `data-integrity.corruption.${id}`,
				action: deepLink,
			});
		}

		if (this.worsened(id, 'wal', signals.wal)) {
			this.deps.incidents.record({
				kind: 'wal-backlog',
				severity: severityOf(signals.wal),
				summary: `${id} WAL backlog (${(ctx.walBytes / 1_048_576).toFixed(0)}MB)`,
				data: { walBytes: ctx.walBytes, mainBytes: ctx.mainBytes, shmPresent: ctx.shmPresent },
			});
		}

		if (this.worsened(id, 'freshness', signals.freshness)) {
			this.deps.incidents.record({
				kind: 'stale-events',
				severity: severityOf(signals.freshness),
				summary: `${id} capture stale (${ctx.ageMinutes?.toFixed(0)}m since last event)`,
				data: { ageMinutes: ctx.ageMinutes, maxSeqno: ctx.maxSeqno },
			});
			if (signals.freshness === 'crit') {
				this.deps.notify.notify({
					title: 'Pieces data — Capture Stale',
					body: `No new ${id} events for ${ctx.ageMinutes?.toFixed(0)} minutes while you were active.`,
					severity: 'crit',
					dedupKey: `data-integrity.stale.${id}`,
					action: deepLink,
				});
			}
		}

		if (this.worsened(id, 'latency', signals.latency)) {
			this.deps.incidents.record({
				kind: 'latency-degraded',
				severity: severityOf(signals.latency),
				summary: `${id} probe latency ${ctx.latencyMs.toFixed(0)}ms`,
				data: { latencyMs: ctx.latencyMs, threshold: ctx.latencyThreshold },
			});
		}

		this.prevSignals.set(id, signals);
	}

	private updateSuspect(id: string, isSuspectNow: boolean, reason: SuspectReason, status: HealthState): void {
		const was = this.suspect.get(id) ?? false;
		if (isSuspectNow && !was) {
			this.suspect.set(id, true);
			this.deps.bus.emit('data-integrity.suspect', { id, reason, at: this.deps.now() });
		} else if (!isSuspectNow && was && status === 'ok') {
			this.suspect.set(id, false);
			this.deps.bus.emit('data-integrity.recovered', { id, at: this.deps.now() });
			this.deps.log.info(`${id} recovered to a clean state`);
		}
	}

	private transitionMissing(db: DbConfig): void {
		const id = db.id;
		const prev = this.prevSignals.get(id) ?? OK_SIGNALS();
		const last = this.deps.history.latest(id);
		if (prev.missing !== 'crit') {
			this.deps.incidents.record({
				kind: 'db-missing',
				severity: 'crit',
				summary: `${id} database file is gone`,
				data: { id, lastKnownBytes: last?.bytes ?? null, missingAt: this.deps.now() },
			});
			this.deps.notify.notify({
				title: 'Pieces data — Database Missing',
				body: `${id} database file has disappeared.`,
				severity: 'crit',
				dedupKey: `data-integrity.missing.${id}`,
				action: { type: 'deep-link', route: `/ext/doctor?db=${id}` },
			});
		}
		this.prevSignals.set(id, { ...OK_SIGNALS(), missing: 'crit' });
		if (!(this.suspect.get(id) ?? false)) {
			this.suspect.set(id, true);
			this.deps.bus.emit('data-integrity.suspect', { id, reason: 'missing', at: this.deps.now() });
		}
	}
}
