import type { Command, HostContext, ScheduleSpec, SettingsSchema } from '@pieces-dev/monitor-sdk';
import { describe, expect, test } from 'vitest';
import { dataIntegrity } from '../extension.js';

interface Recorded {
	schema?: SettingsSchema;
	commands: Command[];
	menuProviders: Array<() => { title?: string }>;
	pages: Array<{ path: string }>;
	widgets: Array<{ id: string }>;
	schedules: Array<{ spec: ScheduleSpec; cancelled: boolean }>;
}

function makeFakeCtx(): { ctx: HostContext; rec: Recorded } {
	const rec: Recorded = {
		commands: [],
		menuProviders: [],
		pages: [],
		widgets: [],
		schedules: [],
	};
	const noop = () => {};
	const ctx = {
		store: { migrate: noop, run: noop, get: () => undefined, all: () => [], prune: () => 0 },
		config: {
			registerSchema: (schema: SettingsSchema) => {
				rec.schema = schema;
			},
			get: () => undefined,
			set: noop,
			all: () => ({}),
			onChange: () => noop,
		},
		health: { report: noop },
		incidents: { record: (i: unknown) => i, query: () => [] },
		log: { debug: noop, info: noop, warn: noop, error: noop, query: () => [] },
		bus: { emit: noop, on: () => noop },
		schedule: {
			schedule: (spec: ScheduleSpec) => {
				const entry = { spec, cancelled: false };
				rec.schedules.push(entry);
				return {
					cancel: () => {
						entry.cancelled = true;
					},
				};
			},
		},
		notify: { notify: noop },
		api: { get: noop, post: noop, ws: noop },
		commands: { register: (c: Command) => rec.commands.push(c) },
		process: {
			listPids: () => [],
			isPiecesRunning: () => false,
			launchPieces: async () => {},
			stopPieces: async () => {},
			killPieces: async () => [],
			openApp: async () => {},
			restartPieces: async () => {},
		},
		menu: { contribute: (p: () => { title?: string }) => rec.menuProviders.push(p) },
		dashboard: {
			widget: (w: { id: string }) => rec.widgets.push(w),
			page: (p: { path: string }) => rec.pages.push(p),
		},
		cli: { command: noop },
		pieces: { discoverPort: async () => null, checkHealth: async () => false, baseUrl: () => null },
	} as unknown as HostContext;
	return { ctx, rec };
}

describe('data-integrity extension wiring', () => {
	test('has a stable identity', () => {
		expect(dataIntegrity.id).toBe('data-integrity');
	});

	test('activate registers schema, commands, menu, dashboard, and a sweep schedule', async () => {
		const { ctx, rec } = makeFakeCtx();
		await dataIntegrity.activate(ctx);
		expect(rec.schema).toBeDefined();
		expect(rec.commands.map((c) => c.id)).toContain('data.check');
		expect(rec.menuProviders[0]?.().title).toBe('Pieces Data');
		expect(rec.pages.some((p) => p.path === '/data')).toBe(true);
		expect(rec.widgets.some((w) => w.id === 'freshness')).toBe(true);
		expect(rec.schedules.some((s) => 'everyMs' in s.spec && s.spec.everyMs === 60_000)).toBe(true);
	});

	test('deactivate cancels the sweep schedule', async () => {
		const { ctx, rec } = makeFakeCtx();
		await dataIntegrity.activate(ctx);
		await dataIntegrity.deactivate?.();
		expect(rec.schedules.every((s) => s.cancelled)).toBe(true);
	});
});
