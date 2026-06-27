import type { Command, HostContext, ScheduleSpec, SettingsSchema } from '@pieces-dev/monitor-sdk';
import { describe, expect, test } from 'vitest';
import { watchdog } from '../extension.js';

interface Recorded {
	schema?: SettingsSchema;
	commands: Command[];
	menuProviders: Array<() => { title?: string }>;
	schedules: Array<{ spec: ScheduleSpec; cancelled: boolean }>;
	busHandlers: Map<string, (payload: unknown) => void>;
	configValues: Map<string, unknown>;
	configHandlers: Array<(key: string, value: unknown) => void>;
}

function makeFakeCtx(): { ctx: HostContext; rec: Recorded } {
	const rec: Recorded = {
		commands: [],
		menuProviders: [],
		schedules: [],
		busHandlers: new Map(),
		configValues: new Map(),
		configHandlers: [],
	};
	const noop = () => {};
	const ctx = {
		store: { migrate: noop, run: noop, get: () => undefined, all: () => [], prune: () => 0 },
		config: {
			registerSchema: (schema: SettingsSchema) => {
				rec.schema = schema;
			},
			get: (key: string) => rec.configValues.get(key),
			set: (key: string, value: unknown) => rec.configValues.set(key, value),
			all: () => Object.fromEntries(rec.configValues),
			onChange: (handler: (key: string, value: unknown) => void) => {
				rec.configHandlers.push(handler);
				return noop;
			},
		},
		health: { report: noop },
		incidents: { record: (i: unknown) => i, query: () => [] },
		log: { debug: noop, info: noop, warn: noop, error: noop, query: () => [] },
		bus: {
			emit: noop,
			on: (event: string, handler: (payload: unknown) => void) => {
				rec.busHandlers.set(event, handler);
				return noop;
			},
		},
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
		dashboard: { widget: noop, page: noop },
		cli: { command: noop },
		pieces: {
			discoverPort: async () => null,
			checkHealth: async () => true,
			baseUrl: () => null,
		},
	} as unknown as HostContext;
	return { ctx, rec };
}

describe('watchdog extension wiring', () => {
	test('has a stable identity', () => {
		expect(watchdog.id).toBe('watchdog');
		expect(typeof watchdog.activate).toBe('function');
	});

	test('activate registers schema, commands, menu, schedules, and bus subscriptions', async () => {
		const { ctx, rec } = makeFakeCtx();
		// manageBootLaunch off so activate doesn't kick a boot sequence in the test.
		rec.configValues.set('manageBootLaunch', false);

		await watchdog.activate(ctx);

		expect(rec.schema).toBeDefined();
		expect(rec.commands.map((c) => c.id)).toContain('watchdog.status');
		expect(rec.commands).toHaveLength(6);
		expect(rec.menuProviders[0]?.().title).toBe('Pieces OS');
		const everyMs = rec.schedules.map((s) => ('everyMs' in s.spec ? s.spec.everyMs : -1));
		expect(everyMs).toContain(10_000); // health
		expect(everyMs).toContain(300_000); // auth
		expect(rec.busHandlers.has('doctor.restore-begin')).toBe(true);
		expect(rec.busHandlers.has('doctor.restore-end')).toBe(true);
	});

	test('reschedules the health task when the interval setting changes', async () => {
		const { ctx, rec } = makeFakeCtx();
		rec.configValues.set('manageBootLaunch', false);
		await watchdog.activate(ctx);
		const before = rec.schedules.length;

		rec.configValues.set('healthIntervalSec', 5);
		for (const handler of rec.configHandlers) handler('healthIntervalSec', 5);

		expect(rec.schedules.length).toBe(before + 1);
		expect(rec.schedules.some((s) => 'everyMs' in s.spec && s.spec.everyMs === 5_000)).toBe(true);
		expect(rec.schedules.some((s) => s.cancelled)).toBe(true); // old health task cancelled
	});

	test('deactivate cancels the scheduled tasks', async () => {
		const { ctx, rec } = makeFakeCtx();
		rec.configValues.set('manageBootLaunch', false);
		await watchdog.activate(ctx);

		await watchdog.deactivate?.();

		expect(rec.schedules.every((s) => s.cancelled)).toBe(true);
	});
});
