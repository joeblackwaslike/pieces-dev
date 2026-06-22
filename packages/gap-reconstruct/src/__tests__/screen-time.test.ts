import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScreenTimeSource } from '../sources/screen-time.js';

// ScreenTimeSource short-circuits off macOS (knowledgeC.db is macOS-only), so
// pin the platform to darwin for deterministic results on any CI runner.
const originalPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));

vi.mock('better-sqlite3', () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			prepare: vi.fn().mockReturnValue({
				all: vi.fn().mockReturnValue([
					{
						ZSTARTDATE: new Date('2026-05-27T10:00:00Z').getTime() / 1000 - 978307200,
						ZENDDATE: new Date('2026-05-27T10:30:00Z').getTime() / 1000 - 978307200,
						ZVALUESTRING: 'com.microsoft.VSCodeInsiders',
					},
					{
						ZSTARTDATE: new Date('2026-05-27T11:00:00Z').getTime() / 1000 - 978307200,
						ZENDDATE: new Date('2026-05-27T11:15:00Z').getTime() / 1000 - 978307200,
						ZVALUESTRING: 'company.thebrowser.Browser',
					},
				]),
			}),
			close: vi.fn(),
		})),
	};
});

describe('ScreenTimeSource', () => {
	it('produces app enter/leave events for all apps', async () => {
		const source = new ScreenTimeSource();
		const events: Array<{ source: string; dedupKey: string }> = [];

		for await (const evt of source.collect(
			new Date('2026-05-27T00:00:00Z'),
			new Date('2026-05-28T00:00:00Z'),
		)) {
			events.push({ source: evt.source, dedupKey: evt.dedupKey });
		}

		expect(events.length).toBeGreaterThanOrEqual(4);
		expect(events.filter((e) => e.dedupKey.includes('application_enter')).length).toBe(2);
		expect(events.filter((e) => e.dedupKey.includes('application_leave')).length).toBe(2);
	});
});
