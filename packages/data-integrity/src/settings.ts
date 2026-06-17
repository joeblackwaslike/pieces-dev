import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConfigApi, SettingsSchema } from '@pieces-dev/monitor-sdk';
import type { DbConfig, FreshnessSource } from './types.js';

export type SnapshotStrategy = 'vacuum-into' | 'readonly-open';

export interface DataIntegritySettings {
	dataDir: string;
	sweepIntervalSec: number;
	integrityCheckIntervalSec: number;
	databases: DbConfig[];
	freshnessSource: FreshnessSource;
	collapseRatio: number;
	minCollapseBytes: number;
	walWarnBytes: number;
	walCritBytes: number;
	freshnessWarnMinutes: number;
	freshnessCritMinutes: number;
	latencyWarnMs: number;
	latencyCritMs: number;
	/** Seconds of no HID input after which the user is "idle" and freshness alarms are suppressed. */
	userIdleSec: number;
	snapshotStrategy: SnapshotStrategy;
}

/** Scalar defaults (the structured `databases`/`freshnessSource`/`dataDir` are built separately). */
export const DATA_DEFAULTS = {
	sweepIntervalSec: 60,
	integrityCheckIntervalSec: 3600,
	collapseRatio: 0.5,
	minCollapseBytes: 1_048_576,
	walWarnBytes: 67_108_864,
	walCritBytes: 268_435_456,
	freshnessWarnMinutes: 30,
	freshnessCritMinutes: 120,
	latencyWarnMs: 500,
	latencyCritMs: 3000,
	userIdleSec: 300,
	snapshotStrategy: 'vacuum-into' as SnapshotStrategy,
};

export function defaultDataDir(): string {
	return join(homedir(), 'Library/com.pieces.os/production/Pieces');
}

export function defaultDatabases(): DbConfig[] {
	return [
		{
			id: 'couchbase',
			glob: 'couchbase.cblite2/db.sqlite3',
			kind: 'couchbase-lite',
			critical: true,
			enabled: true,
		},
		{ id: 'workstream', glob: 'workstream*.sqlite', kind: 'sqlite', critical: true, enabled: true },
		{
			id: 'workstream-archive',
			glob: 'workstream*.archive.sqlite',
			kind: 'sqlite',
			critical: false,
			enabled: true,
		},
		{ id: 'hints', glob: 'hints.sqlite', kind: 'sqlite', critical: false, enabled: true },
		{ id: 'vector', glob: 'vector_db/*.sqlite', kind: 'sqlite', critical: false, enabled: true },
	];
}

export function defaultFreshnessSource(): FreshnessSource {
	// The Couchbase workstream-events collection table (sequence column, decode-free).
	return { dbId: 'couchbase', table: 'kv_.workstream\\Events' };
}

export const DATA_INTEGRITY_SCHEMA: SettingsSchema = {
	sections: [
		{
			id: 'cadence',
			title: 'Sweep Cadence',
			fields: [
				{
					key: 'sweepIntervalSec',
					label: 'Sweep interval (s)',
					help: 'Seconds between size + cheap content probes.',
					type: 'number',
					default: DATA_DEFAULTS.sweepIntervalSec,
					min: 5,
				},
				{
					key: 'integrityCheckIntervalSec',
					label: 'Deep integrity interval (s)',
					help: 'Seconds between expensive PRAGMA integrity scans (plain SQLite only).',
					type: 'number',
					default: DATA_DEFAULTS.integrityCheckIntervalSec,
					min: 60,
				},
			],
		},
		{
			id: 'thresholds',
			title: 'Alarm Thresholds',
			fields: [
				{
					key: 'collapseRatio',
					label: 'Size-collapse ratio',
					help: 'Fraction of baseline a live file may shrink before it is a collapse (0.5 = >50%).',
					type: 'number',
					default: DATA_DEFAULTS.collapseRatio,
					min: 0,
					max: 1,
					step: 0.05,
				},
				{
					key: 'minCollapseBytes',
					label: 'Min collapse drop (bytes)',
					help: 'Absolute drop below baseline required to alarm (filters noise).',
					type: 'number',
					default: DATA_DEFAULTS.minCollapseBytes,
					min: 0,
				},
				{
					key: 'walWarnBytes',
					label: 'WAL warn (bytes)',
					type: 'number',
					default: DATA_DEFAULTS.walWarnBytes,
					min: 0,
				},
				{
					key: 'walCritBytes',
					label: 'WAL crit (bytes)',
					type: 'number',
					default: DATA_DEFAULTS.walCritBytes,
					min: 0,
				},
				{
					key: 'freshnessWarnMinutes',
					label: 'Freshness warn (min)',
					type: 'number',
					default: DATA_DEFAULTS.freshnessWarnMinutes,
					min: 1,
				},
				{
					key: 'freshnessCritMinutes',
					label: 'Freshness crit (min)',
					type: 'number',
					default: DATA_DEFAULTS.freshnessCritMinutes,
					min: 1,
				},
				{
					key: 'latencyWarnMs',
					label: 'Latency warn (ms)',
					type: 'number',
					default: DATA_DEFAULTS.latencyWarnMs,
					min: 1,
				},
				{
					key: 'latencyCritMs',
					label: 'Latency crit (ms)',
					type: 'number',
					default: DATA_DEFAULTS.latencyCritMs,
					min: 1,
				},
			],
		},
		{
			id: 'storage',
			title: 'Storage',
			fields: [
				{
					key: 'dataDir',
					label: 'Pieces data directory',
					help: 'Root the database globs are resolved against.',
					type: 'path',
					default: defaultDataDir(),
				},
				{
					key: 'snapshotStrategy',
					label: 'Deep-integrity snapshot strategy',
					type: 'enum',
					default: DATA_DEFAULTS.snapshotStrategy,
					options: [
						{ label: 'VACUUM INTO snapshot', value: 'vacuum-into' },
						{ label: 'Read-only open', value: 'readonly-open' },
					],
				},
			],
		},
	],
};

export function readSettings(config: ConfigApi): DataIntegritySettings {
	const num = (key: string, fallback: number): number => {
		const v = config.get<number>(key);
		return typeof v === 'number' ? v : fallback;
	};
	const str = <T extends string>(key: string, fallback: T): T => {
		const v = config.get<T>(key);
		return typeof v === 'string' ? v : fallback;
	};
	return {
		dataDir: str('dataDir', defaultDataDir()),
		sweepIntervalSec: num('sweepIntervalSec', DATA_DEFAULTS.sweepIntervalSec),
		integrityCheckIntervalSec: num(
			'integrityCheckIntervalSec',
			DATA_DEFAULTS.integrityCheckIntervalSec,
		),
		databases: config.get<DbConfig[]>('databases') ?? defaultDatabases(),
		freshnessSource: config.get<FreshnessSource>('freshnessSource') ?? defaultFreshnessSource(),
		collapseRatio: num('collapseRatio', DATA_DEFAULTS.collapseRatio),
		minCollapseBytes: num('minCollapseBytes', DATA_DEFAULTS.minCollapseBytes),
		walWarnBytes: num('walWarnBytes', DATA_DEFAULTS.walWarnBytes),
		walCritBytes: num('walCritBytes', DATA_DEFAULTS.walCritBytes),
		freshnessWarnMinutes: num('freshnessWarnMinutes', DATA_DEFAULTS.freshnessWarnMinutes),
		freshnessCritMinutes: num('freshnessCritMinutes', DATA_DEFAULTS.freshnessCritMinutes),
		latencyWarnMs: num('latencyWarnMs', DATA_DEFAULTS.latencyWarnMs),
		latencyCritMs: num('latencyCritMs', DATA_DEFAULTS.latencyCritMs),
		userIdleSec: num('userIdleSec', DATA_DEFAULTS.userIdleSec),
		snapshotStrategy: str<SnapshotStrategy>('snapshotStrategy', DATA_DEFAULTS.snapshotStrategy),
	};
}
