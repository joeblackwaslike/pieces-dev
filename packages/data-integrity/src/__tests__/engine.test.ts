import { describe, expect, test } from 'vitest';
import { DataIntegrityEngine } from '../engine.js';
import type { Baseline } from '../types.js';
import { type EngineHarness, makeEngineHarness } from './engine-harness.js';

const MB = 1_048_576;
const CB = '/data/cb';

function withCouchbase(h: EngineHarness, bytes: number): void {
	h.setGlob('cb', [CB]);
	h.setFile(CB, { bytes });
}

function pin(h: EngineHarness, baselineBytes: number): void {
	const b: Baseline = {
		id: 'couchbase',
		baselineBytes,
		baselineMaxSeqno: 10,
		baselineCount: 5,
		pinnedAt: 1,
		pinnedReason: 'initial-pin',
	};
	h.deps.baseline.pin(b);
}

describe('DataIntegrityEngine — baseline bootstrap', () => {
	test('auto-pins on a clean first sweep', async () => {
		const h = makeEngineHarness();
		withCouchbase(h, 100 * MB);
		h.setProbe(CB, { integrity: 'ok', maxSeqno: 10, count: 5 });
		await new DataIntegrityEngine(h.deps).sweep({ deep: true });
		expect(h.deps.baseline.load('couchbase')?.baselineBytes).toBe(100 * MB);
		expect(h.rec.incidents).toEqual([]);
		expect(h.rec.health.some((r) => r.checkId === 'data.couchbase' && r.state === 'ok')).toBe(true);
	});

	test('reports baseline-pending instead of pinning when Pieces is not authed', async () => {
		const h = makeEngineHarness();
		withCouchbase(h, 100 * MB);
		h.setPieces({ authed: false });
		await new DataIntegrityEngine(h.deps).sweep({ deep: true });
		expect(h.deps.baseline.load('couchbase')).toBeNull();
		expect(
			h.rec.health.some((r) => r.checkId === 'data.couchbase' && r.detail === 'baseline-pending'),
		).toBe(true);
	});
});

describe('DataIntegrityEngine — size collapse', () => {
	test('the 129MB → 2.9MB collapse fires crit incident, notify, and a suspect event', async () => {
		const h = makeEngineHarness();
		pin(h, 129 * MB);
		withCouchbase(h, 2.9 * MB);
		await new DataIntegrityEngine(h.deps).sweep();
		expect(h.rec.incidents.some((i) => i.kind === 'size-collapse' && i.severity === 'crit')).toBe(
			true,
		);
		expect(h.rec.notifies.some((n) => n.severity === 'crit')).toBe(true);
		expect(
			h.rec.events.some(
				(e) =>
					e.event === 'data-integrity.suspect' &&
					(e.payload as { reason: string }).reason === 'collapse',
			),
		).toBe(true);
		expect(h.rec.health.some((r) => r.checkId === 'data.couchbase' && r.state === 'crit')).toBe(
			true,
		);
	});

	test('a persistent collapse records the incident only once (transition-only)', async () => {
		const h = makeEngineHarness();
		pin(h, 129 * MB);
		withCouchbase(h, 2.9 * MB);
		const eng = new DataIntegrityEngine(h.deps);
		await eng.sweep();
		await eng.sweep();
		expect(h.rec.incidents.filter((i) => i.kind === 'size-collapse')).toHaveLength(1);
		expect(h.rec.events.filter((e) => e.event === 'data-integrity.suspect')).toHaveLength(1);
	});

	test('recovery emits data-integrity.recovered once the file returns', async () => {
		const h = makeEngineHarness();
		pin(h, 129 * MB);
		withCouchbase(h, 2.9 * MB);
		const eng = new DataIntegrityEngine(h.deps);
		await eng.sweep();
		h.setFile(CB, { bytes: 129 * MB });
		await eng.sweep();
		expect(h.rec.events.some((e) => e.event === 'data-integrity.recovered')).toBe(true);
	});

	test('never lowers the baseline; ratchets up on growth', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 150 * MB);
		await new DataIntegrityEngine(h.deps).sweep();
		expect(h.deps.baseline.load('couchbase')?.baselineBytes).toBe(150 * MB);
	});
});

describe('DataIntegrityEngine — missing & corruption', () => {
	test('a previously-seen critical DB going missing is crit + suspect(missing)', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		h.setGlob('cb', []); // glob now matches nothing
		await new DataIntegrityEngine(h.deps).sweep();
		expect(h.rec.incidents.some((i) => i.kind === 'db-missing' && i.severity === 'crit')).toBe(
			true,
		);
		expect(
			h.rec.events.some(
				(e) =>
					e.event === 'data-integrity.suspect' &&
					(e.payload as { reason: string }).reason === 'missing',
			),
		).toBe(true);
	});

	test('a failed integrity check is corruption-suspected crit + suspect(corruption)', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 100 * MB);
		h.setProbe(CB, { integrity: '*** btree page 3 corrupt ***' });
		await new DataIntegrityEngine(h.deps).sweep({ deep: true });
		expect(
			h.rec.incidents.some((i) => i.kind === 'corruption-suspected' && i.severity === 'crit'),
		).toBe(true);
		expect(
			h.rec.events.some(
				(e) =>
					e.event === 'data-integrity.suspect' &&
					(e.payload as { reason: string }).reason === 'corruption',
			),
		).toBe(true);
	});

	test('the couchbase tokenizer limitation is NOT treated as corruption', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 100 * MB);
		h.setProbe(CB, { integrity: 'unavailable (couchbase-fts)' });
		await new DataIntegrityEngine(h.deps).sweep({ deep: true });
		expect(h.rec.incidents.some((i) => i.kind === 'corruption-suspected')).toBe(false);
	});
});

describe('DataIntegrityEngine — freshness', () => {
	test('stale capture while active fires stale-events crit + notify', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 100 * MB);
		h.setProbe(CB, { maxSeqno: 10, count: 5 });
		const eng = new DataIntegrityEngine(h.deps);
		await eng.sweep(); // seeds the advance clock at t0
		h.clock.t += 130 * 60_000; // 130 min, seqno unchanged
		await eng.sweep();
		expect(h.rec.incidents.some((i) => i.kind === 'stale-events' && i.severity === 'crit')).toBe(
			true,
		);
		expect(
			h.rec.notifies.some((n) => /auth|stale|capture/i.test(n.title) || n.severity === 'crit'),
		).toBe(true);
	});

	test('staleness is suppressed when the user is idle', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 100 * MB);
		h.setProbe(CB, { maxSeqno: 10, count: 5 });
		const eng = new DataIntegrityEngine(h.deps);
		await eng.sweep();
		h.clock.t += 130 * 60_000;
		h.setIdle(600); // user away > userIdleSec (300)
		await eng.sweep();
		expect(h.rec.incidents.some((i) => i.kind === 'stale-events')).toBe(false);
	});

	test('emits a periodic data-integrity.freshness event for the source DB', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 100 * MB);
		h.setProbe(CB, { maxSeqno: 10, count: 5 });
		await new DataIntegrityEngine(h.deps).sweep();
		expect(
			h.rec.events.some(
				(e) =>
					e.event === 'data-integrity.freshness' &&
					(e.payload as { id: string }).id === 'couchbase',
			),
		).toBe(true);
	});
});

describe('DataIntegrityEngine — wal, latency, meta', () => {
	test('a large WAL fires wal-backlog without a notification', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		h.setGlob('cb', [CB]);
		h.setFile(CB, { bytes: 100 * MB, walBytes: 300 * MB });
		await new DataIntegrityEngine(h.deps).sweep();
		expect(h.rec.incidents.some((i) => i.kind === 'wal-backlog')).toBe(true);
		expect(h.rec.notifies).toEqual([]);
	});

	test('slow probe latency fires latency-degraded', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 100 * MB);
		h.setProbe(CB, { latencyMs: 4000 });
		await new DataIntegrityEngine(h.deps).sweep();
		expect(h.rec.incidents.some((i) => i.kind === 'latency-degraded')).toBe(true);
	});

	test('reports the data.sweep meta-check ok on a successful sweep', async () => {
		const h = makeEngineHarness();
		pin(h, 100 * MB);
		withCouchbase(h, 100 * MB);
		await new DataIntegrityEngine(h.deps).sweep();
		expect(h.rec.health.some((r) => r.checkId === 'data.sweep' && r.state === 'ok')).toBe(true);
	});
});
