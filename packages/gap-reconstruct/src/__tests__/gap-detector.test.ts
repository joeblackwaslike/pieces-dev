import { describe, expect, it } from 'vitest';
import { computeGaps, findGapsInTimeline } from '../gap-detector.js';

describe('findGapsInTimeline', () => {
	it('finds a gap between two event clusters', () => {
		const events = [
			{ timestamp: new Date('2026-05-25T10:00:00Z') },
			{ timestamp: new Date('2026-05-25T10:30:00Z') },
			{ timestamp: new Date('2026-05-25T11:00:00Z') },
			// GAP: May 25 11:00 → May 27 09:00 (46 hours)
			{ timestamp: new Date('2026-05-27T09:00:00Z') },
			{ timestamp: new Date('2026-05-27T09:30:00Z') },
		];

		const minGapMs = 60 * 60 * 1000; // 1 hour
		const gaps = findGapsInTimeline(events, minGapMs);

		expect(gaps.length).toBe(1);
		expect(gaps[0]!.from.toISOString()).toBe('2026-05-25T11:00:00.000Z');
		expect(gaps[0]!.to.toISOString()).toBe('2026-05-27T09:00:00.000Z');
	});

	it('returns empty when no gaps exceed minimum', () => {
		const events = [
			{ timestamp: new Date('2026-05-25T10:00:00Z') },
			{ timestamp: new Date('2026-05-25T10:30:00Z') },
			{ timestamp: new Date('2026-05-25T11:00:00Z') },
		];

		const minGapMs = 2 * 60 * 60 * 1000; // 2 hours
		const gaps = findGapsInTimeline(events, minGapMs);

		expect(gaps.length).toBe(0);
	});

	it('handles empty event list', () => {
		const gaps = findGapsInTimeline([], 60 * 60 * 1000);
		expect(gaps.length).toBe(0);
	});

	it('finds multiple gaps', () => {
		const events = [
			{ timestamp: new Date('2026-05-20T10:00:00Z') },
			// GAP 1: 3 hours
			{ timestamp: new Date('2026-05-20T13:00:00Z') },
			// GAP 2: 5 hours
			{ timestamp: new Date('2026-05-20T18:00:00Z') },
		];

		const minGapMs = 2 * 60 * 60 * 1000; // 2 hours
		const gaps = findGapsInTimeline(events, minGapMs);

		expect(gaps.length).toBe(2);
	});
});

describe('computeGaps', () => {
	const since = new Date('2026-05-25T00:00:00Z');
	const until = new Date('2026-05-25T23:59:59Z');
	const HOUR = 60 * 60 * 1000;

	it('treats an empty window as one whole-range gap', () => {
		const gaps = computeGaps([], since, until, HOUR);
		expect(gaps).toEqual([{ from: since, to: until }]);
	});

	it('detects a leading gap (since → first event)', () => {
		const events = [{ timestamp: new Date('2026-05-25T06:00:00Z') }];
		const gaps = computeGaps(events, since, until, HOUR);
		expect(gaps[0]!.from.toISOString()).toBe(since.toISOString());
		expect(gaps[0]!.to.toISOString()).toBe('2026-05-25T06:00:00.000Z');
	});

	it('detects a trailing gap (last event → until)', () => {
		const events = [{ timestamp: new Date('2026-05-25T06:00:00Z') }];
		const gaps = computeGaps(events, since, until, HOUR);
		const trailing = gaps.at(-1)!;
		expect(trailing.from.toISOString()).toBe('2026-05-25T06:00:00.000Z');
		expect(trailing.to.toISOString()).toBe(until.toISOString());
	});

	it('derives leading/trailing gaps from the latest/earliest event even when input is unsorted', () => {
		// Regression: trailing gap must use the chronologically last event, not
		// the last array element. Input is deliberately out of order.
		const events = [
			{ timestamp: new Date('2026-05-25T20:00:00Z') }, // latest, listed first
			{ timestamp: new Date('2026-05-25T04:00:00Z') }, // earliest, listed last
		];
		const gaps = computeGaps(events, since, until, HOUR);
		expect(gaps[0]!.from.toISOString()).toBe(since.toISOString());
		expect(gaps[0]!.to.toISOString()).toBe('2026-05-25T04:00:00.000Z');
		const trailing = gaps.at(-1)!;
		expect(trailing.from.toISOString()).toBe('2026-05-25T20:00:00.000Z');
		expect(trailing.to.toISOString()).toBe(until.toISOString());
	});

	it('does not mutate the caller’s array', () => {
		const events = [
			{ timestamp: new Date('2026-05-25T20:00:00Z') },
			{ timestamp: new Date('2026-05-25T04:00:00Z') },
		];
		const snapshot = events.map((e) => e.timestamp.toISOString());
		computeGaps(events, since, until, HOUR);
		expect(events.map((e) => e.timestamp.toISOString())).toEqual(snapshot);
	});
});
