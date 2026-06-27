import type { HealthState, IncidentInput, NotificationInput } from '@pieces-dev/monitor-sdk';
import type { RearmHandle, WatchdogDeps } from '../deps.js';
import type { HttpResponse } from '../http.js';
import { WATCHDOG_DEFAULTS, type WatchdogSettings } from '../settings.js';
import type { PersistedState, StatePersistence } from '../state.js';

export interface HealthReportCall {
	checkId: string;
	state: HealthState;
	detail?: string;
}
export interface ProcessCall {
	op: 'listPids' | 'launchPieces' | 'killPieces' | 'openApp';
	arg?: unknown;
}
export interface EventCall {
	event: string;
	payload?: unknown;
}

export interface Harness {
	deps: WatchdogDeps;
	clock: { t: number };
	/** Mutable control surface. */
	control: {
		setHealthy(value: boolean | (() => boolean)): void;
		setPids(value: number[]): void;
		setBaseUrl(value: string | null): void;
		setUser(res: HttpResponse): void;
	};
	rec: {
		health: HealthReportCall[];
		incidents: IncidentInput[];
		notifies: NotificationInput[];
		events: EventCall[];
		process: ProcessCall[];
		saves: Array<Partial<PersistedState>>;
		rearms: Array<{ delayMs: number; fn: () => void; cancelled: boolean }>;
	};
	/** The live persisted state (what load() returns), mutated by save(). */
	persisted: PersistedState;
}

export function makeHarness(
	opts: {
		settings?: Partial<WatchdogSettings>;
		persisted?: Partial<PersistedState>;
		startTime?: number;
	} = {},
): Harness {
	const clock = { t: opts.startTime ?? 0 };
	let healthy: boolean | (() => boolean) = false;
	let pids: number[] = [1];
	let baseUrl: string | null = 'http://127.0.0.1:39300';
	let user: HttpResponse = { status: 200, body: JSON.stringify({ id: 'u1' }) };

	const persisted: PersistedState = {
		restartCount: 0,
		lastCleanTime: 0,
		gaveUp: false,
		gaveUpAt: 0,
		authLoggedIn: true,
		...opts.persisted,
	};

	const rec: Harness['rec'] = {
		health: [],
		incidents: [],
		notifies: [],
		events: [],
		process: [],
		saves: [],
		rearms: [],
	};

	const persist: StatePersistence = {
		load: () => ({ ...persisted }),
		save: (patch) => {
			Object.assign(persisted, patch);
			rec.saves.push(patch);
		},
	};

	const settings: WatchdogSettings = { ...WATCHDOG_DEFAULTS, ...opts.settings };

	const deps: WatchdogDeps = {
		now: () => clock.t,
		sleep: async (ms) => {
			clock.t += ms;
		},
		process: {
			listPids: (_matcher) => {
				rec.process.push({ op: 'listPids' });
				return [...pids];
			},
			launchPieces: async () => {
				rec.process.push({ op: 'launchPieces' });
			},
			killPieces: async (signal) => {
				rec.process.push({ op: 'killPieces', arg: signal });
				return [];
			},
			openApp: async () => {
				rec.process.push({ op: 'openApp' });
			},
		},
		pieces: {
			baseUrl: () => baseUrl,
			checkHealth: async () => (typeof healthy === 'function' ? healthy() : healthy),
		},
		httpGet: async (_url) => user,
		httpPost: async (_url) => ({ status: 200, body: '' }),
		health: { report: (checkId, state, detail) => rec.health.push({ checkId, state, detail }) },
		incidents: {
			record: (input) => {
				rec.incidents.push(input);
				return { ...input, id: 'i', source: 'watchdog', at: clock.t };
			},
		},
		notify: { notify: (input) => rec.notifies.push(input) },
		log: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
			query: () => [],
		},
		bus: {
			emit: (event, payload) => rec.events.push({ event, payload }),
			on: () => () => {},
		},
		settings: () => settings,
		persist,
		scheduleRearm: (delayMs, fn): RearmHandle => {
			const entry = { delayMs, fn, cancelled: false };
			rec.rearms.push(entry);
			return {
				cancel: () => {
					entry.cancelled = true;
				},
			};
		},
	};

	return {
		deps,
		clock,
		control: {
			setHealthy: (value) => {
				healthy = value;
			},
			setPids: (value) => {
				pids = value;
			},
			setBaseUrl: (value) => {
				baseUrl = value;
			},
			setUser: (res) => {
				user = res;
			},
		},
		rec,
		persisted,
	};
}
