import type { IncidentInput, NotificationInput } from '@pieces-dev/monitor-sdk';
import { createBaselineStore } from '../baseline.js';
import type { DataIntegrityDeps } from '../deps.js';
import { createHistoryStore } from '../history.js';
import { DATA_DEFAULTS, type DataIntegritySettings, defaultFreshnessSource } from '../settings.js';
import type { DbProbe } from '../sqlite.js';
import type { DbConfig } from '../types.js';
import { memStore } from './store-helper.js';

interface FileEntry {
	bytes: number;
	walBytes: number;
	shmPresent: boolean;
}

export interface EngineHarness {
	deps: DataIntegrityDeps;
	clock: { t: number };
	rec: {
		health: Array<{ checkId: string; state: string; detail?: string }>;
		incidents: IncidentInput[];
		notifies: NotificationInput[];
		events: Array<{ event: string; payload?: unknown }>;
	};
	setGlob(glob: string, paths: string[]): void;
	setFile(path: string, entry: Partial<FileEntry> & { bytes: number }): void;
	removeFile(path: string): void;
	setProbe(path: string, probe: Partial<DbProbe>): void;
	setPieces(opts: { healthy?: boolean; authed?: boolean }): void;
	setIdle(seconds: number): void;
}

const DEFAULT_DB: DbConfig = {
	id: 'couchbase',
	glob: 'cb',
	kind: 'couchbase-lite',
	critical: true,
	enabled: true,
};

export function makeEngineHarness(
	opts: { settings?: Partial<DataIntegritySettings>; databases?: DbConfig[] } = {},
): EngineHarness {
	const clock = { t: 1_000_000 };
	const globs = new Map<string, string[]>();
	const files = new Map<string, FileEntry>();
	const probes = new Map<string, DbProbe>();
	let healthy = true;
	let authed = true;
	let idle = 0;

	const settings: DataIntegritySettings = {
		...DATA_DEFAULTS,
		dataDir: '/data',
		databases: opts.databases ?? [DEFAULT_DB],
		freshnessSource: defaultFreshnessSource(),
		...opts.settings,
	};
	// point the freshness source at the default test db unless overridden
	if (!opts.settings?.freshnessSource)
		settings.freshnessSource = { dbId: 'couchbase', table: 'evt' };

	const rec: EngineHarness['rec'] = { health: [], incidents: [], notifies: [], events: [] };
	const store = memStore();

	const defaultProbe = (): DbProbe => ({
		opened: true,
		pageCount: 100,
		latencyMs: 1,
		integrity: null,
		maxSeqno: null,
		count: null,
	});

	const deps: DataIntegrityDeps = {
		now: () => clock.t,
		settings: () => settings,
		statFile: (path) => {
			const f = files.get(path);
			return f ? { exists: true, bytes: f.bytes } : { exists: false, bytes: 0 };
		},
		walInfo: (path) => {
			const f = files.get(path);
			return { walBytes: f?.walBytes ?? 0, shmPresent: f?.shmPresent ?? false };
		},
		expandGlob: (_dataDir, glob) => globs.get(glob) ?? [],
		probe: (path) => probes.get(path) ?? defaultProbe(),
		piecesHealthy: async () => healthy,
		piecesAuthed: async () => authed,
		idleSeconds: () => idle,
		health: { report: (checkId, state, detail) => rec.health.push({ checkId, state, detail }) },
		incidents: {
			record: (input) => {
				rec.incidents.push(input);
				return { ...input, id: 'i', source: 'data-integrity', at: clock.t };
			},
		},
		notify: { notify: (input) => rec.notifies.push(input) },
		log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, query: () => [] },
		bus: { emit: (event, payload) => rec.events.push({ event, payload }), on: () => () => {} },
		baseline: createBaselineStore(store),
		history: createHistoryStore(store),
	};

	return {
		deps,
		clock,
		rec,
		setGlob: (glob, paths) => globs.set(glob, paths),
		setFile: (path, entry) => files.set(path, { walBytes: 0, shmPresent: false, ...entry }),
		removeFile: (path) => files.delete(path),
		setProbe: (path, probe) => probes.set(path, { ...defaultProbe(), ...probe }),
		setPieces: ({ healthy: h, authed: a }) => {
			if (h !== undefined) healthy = h;
			if (a !== undefined) authed = a;
		},
		setIdle: (seconds) => {
			idle = seconds;
		},
	};
}
