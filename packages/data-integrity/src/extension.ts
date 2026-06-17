import type { Extension, HostContext, ScheduleHandle } from '@pieces-dev/monitor-sdk';
import { createBaselineStore } from './baseline.js';
import { buildCommands } from './commands.js';
import { renderDataTable, renderFreshness } from './dashboard.js';
import type { DataIntegrityDeps } from './deps.js';
import { DataIntegrityEngine } from './engine.js';
import { expandGlob, statFile, walInfo } from './fs.js';
import { createHistoryStore } from './history.js';
import { idleSeconds } from './idle.js';
import { buildMenuSection } from './menu.js';
import { DATA_INTEGRITY_SCHEMA, readSettings } from './settings.js';
import { probe } from './sqlite.js';

/** GET <baseUrl>/user → logged-in (Pieces authed). Mirrors the watchdog's auth probe. */
async function piecesAuthed(baseUrl: string | null): Promise<boolean> {
	if (!baseUrl) return false;
	try {
		const res = await fetch(`${baseUrl}/user`);
		if (res.status !== 200) return false;
		const data = (await res.json()) as Record<string, unknown>;
		const user = (data?.user ?? data) as Record<string, unknown> | undefined;
		return !!(user && (user.id || user.email));
	} catch {
		return false;
	}
}

function depsFromContext(ctx: HostContext): DataIntegrityDeps {
	return {
		now: () => Date.now(),
		settings: () => readSettings(ctx.config),
		statFile,
		walInfo,
		expandGlob,
		probe,
		piecesHealthy: () => ctx.pieces.checkHealth(),
		piecesAuthed: () => piecesAuthed(ctx.pieces.baseUrl()),
		idleSeconds: () => idleSeconds(),
		health: ctx.health,
		incidents: ctx.incidents,
		notify: ctx.notify,
		log: ctx.log,
		bus: ctx.bus,
		baseline: createBaselineStore(ctx.store),
		history: createHistoryStore(ctx.store),
	};
}

/** The Pieces data-integrity monitor: per-DB collapse/corruption/freshness sweep. */
class DataIntegrity implements Extension {
	readonly id = 'data-integrity';
	readonly name = 'Pieces Data Integrity';
	readonly version = '0.1.0';

	private sweepTask: ScheduleHandle | null = null;
	private disposers: Array<() => void> = [];
	private sweepIntervalSec = 0;

	async activate(ctx: HostContext): Promise<void> {
		ctx.config.registerSchema(DATA_INTEGRITY_SCHEMA);

		const deps = depsFromContext(ctx);
		const engine = new DataIntegrityEngine(deps);

		for (const command of buildCommands(engine)) ctx.commands.register(command);
		ctx.menu.contribute(() => buildMenuSection(engine.snapshot()));

		const latestSamples = () =>
			readSettings(ctx.config)
				.databases.map((d) => deps.history.latest(d.id))
				.filter((s): s is NonNullable<typeof s> => s !== null);
		ctx.dashboard.page({
			path: '/data',
			title: 'Data Integrity',
			render: () => renderDataTable(latestSamples()),
		});
		ctx.dashboard.widget({
			id: 'freshness',
			render: () =>
				renderFreshness(deps.history.latest(readSettings(ctx.config).freshnessSource.dbId)),
		});

		this.sweepIntervalSec = readSettings(ctx.config).sweepIntervalSec;
		this.sweepTask = ctx.schedule.schedule({ everyMs: this.sweepIntervalSec * 1000 }, () => {
			void engine.sweep();
		});

		this.disposers.push(
			ctx.config.onChange(() => {
				const next = readSettings(ctx.config).sweepIntervalSec;
				if (next !== this.sweepIntervalSec) {
					this.sweepIntervalSec = next;
					this.sweepTask?.cancel();
					this.sweepTask = ctx.schedule.schedule({ everyMs: this.sweepIntervalSec * 1000 }, () => {
						void engine.sweep();
					});
				}
			}),
		);

		// Kick an immediate deep sweep so health/baseline populate promptly (detached).
		void engine.sweep({ deep: true });
	}

	async deactivate(): Promise<void> {
		this.sweepTask?.cancel();
		for (const dispose of this.disposers) dispose();
		this.disposers = [];
	}
}

export const dataIntegrity: Extension = new DataIntegrity();
