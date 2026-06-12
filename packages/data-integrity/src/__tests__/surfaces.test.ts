import { describe, expect, test } from 'vitest';
import { buildCommands } from '../commands.js';
import { renderDataTable, renderFreshness } from '../dashboard.js';
import { DataIntegrityEngine } from '../engine.js';
import { buildMenuSection } from '../menu.js';
import type { DbSample } from '../types.js';
import { makeEngineHarness } from './engine-harness.js';

const MB = 1_048_576;

function commands() {
	const h = makeEngineHarness();
	h.setGlob('cb', ['/data/cb']);
	h.setFile('/data/cb', { bytes: 100 * MB });
	const engine = new DataIntegrityEngine(h.deps);
	return { h, engine, byId: new Map(buildCommands(engine).map((c) => [c.id, c])) };
}

describe('data-integrity commands', () => {
	test('registers status, check, and pin-baseline', () => {
		const { byId } = commands();
		expect(byId.has('data.status')).toBe(true);
		expect(byId.has('data.check')).toBe(true);
		expect(byId.has('data.pin-baseline')).toBe(true);
	});

	test('data.check forces a sweep and returns per-DB reports', async () => {
		const { byId } = commands();
		const reports = (await byId.get('data.check')?.handler()) as Array<{ id: string }>;
		expect(reports.some((r) => r.id === 'couchbase')).toBe(true);
	});

	test('data.status returns the current snapshot', async () => {
		const { byId } = commands();
		await byId.get('data.check')?.handler();
		const snap = (await byId.get('data.status')?.handler()) as Array<{ id: string }>;
		expect(snap.some((r) => r.id === 'couchbase')).toBe(true);
	});

	test('data.pin-baseline pins the current state', async () => {
		const { h, byId } = commands();
		await byId.get('data.check')?.handler();
		const result = (await byId.get('data.pin-baseline')?.handler({ db: 'couchbase' })) as { pinned: boolean };
		expect(result.pinned).toBe(true);
		expect(h.deps.baseline.load('couchbase')?.pinnedReason).toBe('operator-ack');
	});
});

const sample = (over: Partial<DbSample> = {}): DbSample => ({
	id: 'couchbase',
	ts: 1000,
	bytes: 95 * MB,
	walBytes: 0,
	shmPresent: false,
	maxSeqno: 42,
	count: 10,
	ageMinutes: 3,
	latencyMs: 2,
	integrity: 'ok',
	status: 'ok',
	...over,
});

describe('data-integrity menu', () => {
	test('titled "Pieces Data" with a re-check command and per-DB rows', () => {
		const section = buildMenuSection([
			{ id: 'couchbase', status: 'crit', suspect: true },
			{ id: 'vector', status: 'ok', suspect: false },
		]);
		expect(section.title).toBe('Pieces Data');
		expect(section.items.some((i) => /couchbase/i.test(i.label))).toBe(true);
		expect(
			section.items.some((i) => i.action?.type === 'run-command' && i.action.commandId === 'data.check'),
		).toBe(true);
	});
});

describe('data-integrity dashboard', () => {
	test('freshness widget shows the age and a colored state', () => {
		const html = renderFreshness(sample({ ageMinutes: 3 }));
		expect(html).toMatch(/3/);
		expect(html.toLowerCase()).toContain('event');
	});

	test('data table lists each DB with its size and status', () => {
		const html = renderDataTable([sample({ id: 'couchbase', status: 'crit' })]);
		expect(html).toContain('couchbase');
		expect(html).toContain('crit');
		expect(html).toMatch(/95(\.0)?\s*MB/i);
	});

	test('data table handles an empty set', () => {
		expect(renderDataTable([])).toMatch(/no/i);
	});
});
