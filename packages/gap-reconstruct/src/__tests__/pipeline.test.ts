import type { SourceEvent } from '@pieces-dev/core';
import { describe, expect, it } from 'vitest';
import { dedup } from '../pipeline.js';

const makeEvent = (
	source: 'claude' | 'screentime' | 'arc' | 'git',
	dedupKey: string,
	timestamp: Date,
): SourceEvent => ({
	timestamp,
	event: {
		application: { id: '1', name: 'VS_CODE', version: '1', platform: 'MACOS' },
		trigger: { check_in: true },
	},
	source,
	dedupKey,
});

describe('dedup', () => {
	it('removes duplicates with same dedupKey, keeping higher priority source', () => {
		const events: SourceEvent[] = [
			makeEvent('git', 'file_open:/src/a.ts:1000', new Date('2026-05-27T10:00:00Z')),
			makeEvent('claude', 'file_open:/src/a.ts:1000', new Date('2026-05-27T10:00:01Z')),
			makeEvent('arc', 'url_changed:https://x.com:2000', new Date('2026-05-27T11:00:00Z')),
		];

		const result = dedup(events);

		expect(result.length).toBe(2);
		expect(result[0]!.source).toBe('claude');
		expect(result[1]!.source).toBe('arc');
	});

	it('keeps events with different dedupKeys', () => {
		const events: SourceEvent[] = [
			makeEvent('claude', 'file_open:/a.ts:1000', new Date('2026-05-27T10:00:00Z')),
			makeEvent('claude', 'file_open:/b.ts:1000', new Date('2026-05-27T10:00:01Z')),
		];

		const result = dedup(events);
		expect(result.length).toBe(2);
	});
});
