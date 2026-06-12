import type { ConfigApi } from '@pieces-dev/monitor-sdk';
import { describe, expect, test } from 'vitest';
import { DATA_DEFAULTS, DATA_INTEGRITY_SCHEMA, defaultDatabases, readSettings } from '../settings.js';

function fakeConfig(values: Record<string, unknown> = {}): ConfigApi {
	const store = new Map(Object.entries(values));
	return {
		registerSchema: () => {},
		get: <T = unknown>(key: string) => store.get(key) as T | undefined,
		set: (key, value) => {
			store.set(key, value);
		},
		all: () => Object.fromEntries(store),
		onChange: () => () => {},
	};
}

describe('data-integrity settings', () => {
	test('readSettings falls back to ported defaults', () => {
		const s = readSettings(fakeConfig());
		expect(s.sweepIntervalSec).toBe(60);
		expect(s.integrityCheckIntervalSec).toBe(3600);
		expect(s.collapseRatio).toBe(0.5);
		expect(s.minCollapseBytes).toBe(1_048_576);
		expect(s.walWarnBytes).toBe(67_108_864);
		expect(s.walCritBytes).toBe(268_435_456);
		expect(s.freshnessWarnMinutes).toBe(30);
		expect(s.freshnessCritMinutes).toBe(120);
		expect(s.latencyWarnMs).toBe(500);
		expect(s.latencyCritMs).toBe(3000);
	});

	test('defaults include the five spec databases with criticality', () => {
		const dbs = readSettings(fakeConfig()).databases;
		const couchbase = dbs.find((d) => d.id === 'couchbase');
		expect(couchbase?.critical).toBe(true);
		expect(couchbase?.kind).toBe('couchbase-lite');
		expect(dbs.find((d) => d.id === 'vector')?.critical).toBe(false);
		expect(dbs.map((d) => d.id)).toEqual(
			expect.arrayContaining(['couchbase', 'workstream', 'workstream-archive', 'hints', 'vector']),
		);
	});

	test('dataDir defaults under the Pieces production dir', () => {
		expect(readSettings(fakeConfig()).dataDir).toMatch(/com\.pieces\.os\/production\/Pieces$/);
	});

	test('config overrides win over defaults', () => {
		const s = readSettings(fakeConfig({ collapseRatio: 0.8, sweepIntervalSec: 30 }));
		expect(s.collapseRatio).toBe(0.8);
		expect(s.sweepIntervalSec).toBe(30);
		expect(s.minCollapseBytes).toBe(DATA_DEFAULTS.minCollapseBytes);
	});

	test('schema exposes the scalar threshold fields', () => {
		const keys = DATA_INTEGRITY_SCHEMA.sections.flatMap((s) => s.fields.map((f) => f.key));
		expect(keys).toEqual(
			expect.arrayContaining(['sweepIntervalSec', 'collapseRatio', 'walWarnBytes', 'freshnessCritMinutes']),
		);
	});

	test('defaultDatabases is a fresh array each call (no shared mutation)', () => {
		const a = defaultDatabases();
		a[0]!.enabled = false;
		expect(defaultDatabases()[0]!.enabled).toBe(true);
	});
});
