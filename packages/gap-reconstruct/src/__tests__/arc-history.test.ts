import { describe, expect, it, vi } from 'vitest';
import { ArcHistorySource } from '../sources/arc-history.js';

vi.mock('better-sqlite3', () => {
  const CHROME_EPOCH_OFFSET = 11644473600;
  const testTime = new Date('2026-05-27T12:00:00Z').getTime() / 1000 + CHROME_EPOCH_OFFSET;
  return {
    default: vi.fn().mockImplementation(() => ({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            url: 'https://github.com/pieces-app',
            title: 'Pieces App - GitHub',
            last_visit_time: testTime * 1_000_000,
          },
        ]),
      }),
      close: vi.fn(),
    })),
  };
});

describe('ArcHistorySource', () => {
  it('produces url_changed events from history', async () => {
    const source = new ArcHistorySource();
    const events: Array<{ source: string; dedupKey: string }> = [];

    for await (const evt of source.collect(
      new Date('2026-05-27T00:00:00Z'),
      new Date('2026-05-28T00:00:00Z'),
    )) {
      events.push({ source: evt.source, dedupKey: evt.dedupKey });
    }

    expect(events.length).toBe(1);
    expect(events[0]!.source).toBe('arc');
    expect(events[0]!.dedupKey).toContain('url_changed');
  });
});
