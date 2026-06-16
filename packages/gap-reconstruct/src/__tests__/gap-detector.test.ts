import { describe, expect, it } from 'vitest';
import { findGapsInTimeline } from '../gap-detector.js';

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
