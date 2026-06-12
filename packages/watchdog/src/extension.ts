import type { Extension, HostContext, ScheduleHandle } from '@pieces-dev/monitor-sdk';
import { buildCommands } from './commands.js';
import type { WatchdogDeps } from './deps.js';
import { WatchdogEngine } from './engine.js';
import { httpGet, httpPost } from './http.js';
import { buildMenuSection } from './menu.js';
import { WATCHDOG_SCHEMA, readSettings } from './settings.js';
import { createStatePersistence } from './state.js';

/** Build the injectable seam from a live {@link HostContext}. */
function depsFromContext(ctx: HostContext): WatchdogDeps {
	return {
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		process: ctx.process,
		pieces: ctx.pieces,
		httpGet,
		httpPost,
		health: ctx.health,
		incidents: ctx.incidents,
		notify: ctx.notify,
		log: ctx.log,
		bus: ctx.bus,
		settings: () => readSettings(ctx.config),
		persist: createStatePersistence(ctx.store),
		scheduleRearm: (delayMs, fn) => {
			const id = setTimeout(fn, delayMs);
			return { cancel: () => clearTimeout(id) };
		},
	};
}

/**
 * The Pieces OS watchdog: a supervised, escalated restart manager + auth monitor,
 * ported from `pieces_babysitter.py` onto the Pieces Monitor extension platform.
 */
class Watchdog implements Extension {
	readonly id = 'watchdog';
	readonly name = 'Pieces OS Watchdog';
	readonly version = '0.1.0';

	private engine: WatchdogEngine | null = null;
	private healthTask: ScheduleHandle | null = null;
	private authTask: ScheduleHandle | null = null;
	private disposers: Array<() => void> = [];
	private healthIntervalSec = 0;
	private authIntervalSec = 0;

	async activate(ctx: HostContext): Promise<void> {
		ctx.config.registerSchema(WATCHDOG_SCHEMA);

		const deps = depsFromContext(ctx);
		const engine = new WatchdogEngine(deps);
		this.engine = engine;

		for (const command of buildCommands(engine)) ctx.commands.register(command);
		ctx.menu.contribute(() => buildMenuSection(engine.snapshot()));

		this.disposers.push(
			ctx.bus.on('doctor.restore-begin', (payload) =>
				engine.onRestoreBegin((payload ?? {}) as { restoreId?: string }),
			),
			ctx.bus.on('doctor.restore-end', () => engine.onRestoreEnd()),
		);

		const settings = readSettings(ctx.config);
		this.healthIntervalSec = settings.healthIntervalSec;
		this.authIntervalSec = settings.authCheckIntervalSec;
		this.healthTask = ctx.schedule.schedule({ everyMs: this.healthIntervalSec * 1000 }, () =>
			engine.healthTick(),
		);
		this.authTask = ctx.schedule.schedule({ everyMs: this.authIntervalSec * 1000 }, () =>
			engine.authTick(),
		);

		// Live-reload the tick intervals when their settings change.
		this.disposers.push(
			ctx.config.onChange(() => {
				const next = readSettings(ctx.config);
				if (next.healthIntervalSec !== this.healthIntervalSec) {
					this.healthIntervalSec = next.healthIntervalSec;
					this.healthTask?.cancel();
					this.healthTask = ctx.schedule.schedule(
						{ everyMs: this.healthIntervalSec * 1000 },
						() => engine.healthTick(),
					);
				}
				if (next.authCheckIntervalSec !== this.authIntervalSec) {
					this.authIntervalSec = next.authCheckIntervalSec;
					this.authTask?.cancel();
					this.authTask = ctx.schedule.schedule(
						{ everyMs: this.authIntervalSec * 1000 },
						() => engine.authTick(),
					);
				}
			}),
		);

		// Boot launch runs detached — it waits up to the startup grace window, which
		// must not block the daemon's extension-load loop.
		void engine.bootLaunch();
	}

	async deactivate(): Promise<void> {
		this.healthTask?.cancel();
		this.authTask?.cancel();
		for (const dispose of this.disposers) dispose();
		this.disposers = [];
		await this.engine?.pendingEscalation;
	}
}

export const watchdog: Extension = new Watchdog();
