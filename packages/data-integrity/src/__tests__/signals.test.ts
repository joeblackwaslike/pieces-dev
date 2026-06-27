import { describe, expect, test } from 'vitest';
import {
	evalFreshness,
	evalIntegrity,
	evalLatency,
	evalSeqno,
	evalSizeCollapse,
	evalWal,
	worst,
} from '../signals.js';

const MB = 1_048_576;

describe('size-collapse signal', () => {
	test('the 129MB → 2.9MB catastrophe trips crit', () => {
		const r = evalSizeCollapse(2.9 * MB, 129 * MB, 0.5, MB);
		expect(r.collapsed).toBe(true);
		expect(r.state).toBe('crit');
		expect(r.dropRatio).toBeGreaterThan(0.9);
	});

	test('healthy growth does not trip', () => {
		expect(evalSizeCollapse(140 * MB, 129 * MB, 0.5, MB).collapsed).toBe(false);
	});

	test('a tiny shrink under the absolute floor does not trip', () => {
		// 50% ratio met only if also > minCollapseBytes; 0.5MB drop is below 1MB floor.
		const r = evalSizeCollapse(1.5 * MB, 2 * MB, 0.5, MB);
		expect(r.collapsed).toBe(false);
	});

	test('no baseline yet → cannot collapse', () => {
		expect(evalSizeCollapse(2 * MB, 0, 0.5, MB).collapsed).toBe(false);
	});
});

describe('wal-backlog signal', () => {
	test('warns past the warn threshold', () => {
		expect(evalWal(80 * MB, 64 * MB, 256 * MB, false).state).toBe('warn');
	});
	test('crit past the crit threshold', () => {
		expect(evalWal(300 * MB, 64 * MB, 256 * MB, false).state).toBe('crit');
	});
	test('crit when WAL keeps growing without the main file growing', () => {
		expect(evalWal(10 * MB, 64 * MB, 256 * MB, true).state).toBe('crit');
	});
	test('ok when small and checkpointing', () => {
		expect(evalWal(1 * MB, 64 * MB, 256 * MB, false).state).toBe('ok');
	});
});

describe('freshness signal', () => {
	test('crit past the crit minutes when the gate is active', () => {
		expect(evalFreshness(130, true, 30, 120).state).toBe('crit');
	});
	test('warn between warn and crit', () => {
		expect(evalFreshness(45, true, 30, 120).state).toBe('warn');
	});
	test('suppressed when the gate is inactive (idle / Pieces down)', () => {
		expect(evalFreshness(500, false, 30, 120).state).toBe('ok');
	});
	test('unknown age never alarms', () => {
		expect(evalFreshness(null, true, 30, 120).state).toBe('ok');
	});
});

describe('latency signal', () => {
	test('warn/crit thresholds', () => {
		expect(evalLatency(600, 500, 3000).state).toBe('warn');
		expect(evalLatency(4000, 500, 3000).state).toBe('crit');
		expect(evalLatency(50, 500, 3000).state).toBe('ok');
	});
});

describe('seqno-gap signal (couchbase)', () => {
	test('a sequence rollback is suspect', () => {
		expect(evalSeqno(90, 100, 100, 100).suspect).toBe(true);
	});
	test('advancing seqno but falling count (holes) is suspect', () => {
		expect(evalSeqno(110, 90, 100, 100).suspect).toBe(true);
	});
	test('normal forward progress is not suspect', () => {
		expect(evalSeqno(110, 105, 100, 100).suspect).toBe(false);
	});
	test('missing prior sample is not suspect (nothing to compare)', () => {
		expect(evalSeqno(100, 100, null, null).suspect).toBe(false);
	});
});

describe('integrity signal', () => {
	test('"ok" is healthy', () => {
		expect(evalIntegrity('ok').state).toBe('ok');
	});
	test('the couchbase tokenizer limitation is not corruption', () => {
		const r = evalIntegrity('unavailable (couchbase-fts)');
		expect(r.state).toBe('ok');
		expect(r.corrupt).toBe(false);
	});
	test('any other output is crit corruption', () => {
		const r = evalIntegrity('*** in database main ***\nPage 42: btree corruption');
		expect(r.state).toBe('crit');
		expect(r.corrupt).toBe(true);
	});
});

describe('worst', () => {
	test('ranks crit over warn over ok', () => {
		expect(worst(['ok', 'warn', 'crit'])).toBe('crit');
		expect(worst(['ok', 'warn'])).toBe('warn');
		expect(worst(['ok', 'ok'])).toBe('ok');
		expect(worst([])).toBe('ok');
	});
});
