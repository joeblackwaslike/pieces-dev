import { describe, expect, test } from 'vitest';
import { canAutoPin, createBaselineStore } from '../baseline.js';
import { createHistoryStore } from '../history.js';
import type { DbSample } from '../types.js';
import { memStore } from './store-helper.js';

const sample = (over: Partial<DbSample> = {}): DbSample => ({
	id: 'couchbase',
	ts: 1000,
	bytes: 100,
	walBytes: 0,
	shmPresent: false,
	maxSeqno: 5,
	count: 3,
	ageMinutes: null,
	latencyMs: 2,
	integrity: 'ok',
	status: 'ok',
	...over,
});

describe('baseline store', () => {
	test('load is null before anything is pinned', () => {
		expect(createBaselineStore(memStore()).load('couchbase')).toBeNull();
	});

	test('pin then load round-trips', () => {
		const b = createBaselineStore(memStore());
		b.pin({
			id: 'couchbase',
			baselineBytes: 1000,
			baselineMaxSeqno: 9,
			baselineCount: 4,
			pinnedAt: 1,
			pinnedReason: 'initial-pin',
		});
		expect(b.load('couchbase')).toMatchObject({ baselineBytes: 1000, pinnedReason: 'initial-pin' });
	});

	test('ratchet raises the baseline only when the file grows', () => {
		const b = createBaselineStore(memStore());
		b.pin({
			id: 'couchbase',
			baselineBytes: 1000,
			baselineMaxSeqno: 9,
			baselineCount: 4,
			pinnedAt: 1,
			pinnedReason: 'initial-pin',
		});
		// grew → raise
		expect(b.ratchet('couchbase', 1500, 12, 6, 2).baselineBytes).toBe(1500);
		// shrank → unchanged (collapse must never lower the baseline)
		expect(b.ratchet('couchbase', 200, 13, 7, 3).baselineBytes).toBe(1500);
	});

	test('canAutoPin refuses corrupt, stale, empty, or unauthed first-run states', () => {
		expect(
			canAutoPin({ bytes: 100, integrityCrit: false, freshnessCrit: false, piecesAuthed: true }),
		).toBe(true);
		expect(
			canAutoPin({ bytes: 100, integrityCrit: true, freshnessCrit: false, piecesAuthed: true }),
		).toBe(false);
		expect(
			canAutoPin({ bytes: 100, integrityCrit: false, freshnessCrit: true, piecesAuthed: true }),
		).toBe(false);
		expect(
			canAutoPin({ bytes: 0, integrityCrit: false, freshnessCrit: false, piecesAuthed: true }),
		).toBe(false);
		expect(
			canAutoPin({ bytes: 100, integrityCrit: false, freshnessCrit: false, piecesAuthed: false }),
		).toBe(false);
	});
});

describe('history store', () => {
	test('append then latest/recent reads back newest-first', () => {
		const h = createHistoryStore(memStore());
		h.append(sample({ ts: 1000, bytes: 100 }));
		h.append(sample({ ts: 2000, bytes: 200 }));
		expect(h.latest('couchbase')?.bytes).toBe(200);
		expect(h.recent('couchbase', 10).map((s) => s.ts)).toEqual([2000, 1000]);
	});

	test('nullable columns round-trip', () => {
		const h = createHistoryStore(memStore());
		h.append(sample({ maxSeqno: null, count: null, ageMinutes: 12.5, integrity: null }));
		const got = h.latest('couchbase');
		expect(got?.maxSeqno).toBeNull();
		expect(got?.ageMinutes).toBe(12.5);
		expect(got?.integrity).toBeNull();
	});

	test('latest is scoped per DB id', () => {
		const h = createHistoryStore(memStore());
		h.append(sample({ id: 'couchbase', ts: 1, bytes: 1 }));
		h.append(sample({ id: 'vector', ts: 2, bytes: 9 }));
		expect(h.latest('couchbase')?.bytes).toBe(1);
		expect(h.latest('vector')?.bytes).toBe(9);
	});
});
