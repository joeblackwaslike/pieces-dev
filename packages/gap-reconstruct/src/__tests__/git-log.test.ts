import { describe, expect, it, vi } from 'vitest';
import { GitLogSource } from '../sources/git-log.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(
    'abc123|2026-05-27T14:00:00+00:00|Fix auth bug\n' +
      'src/auth.ts\n' +
      'src/auth.test.ts\n' +
      '\n',
  ),
}));

describe('GitLogSource', () => {
  it('produces check_in and tab_switch events from git log', async () => {
    const source = new GitLogSource(['/Users/joe/project']);
    const events: Array<{ source: string; dedupKey: string }> = [];

    for await (const evt of source.collect(
      new Date('2026-05-27T00:00:00Z'),
      new Date('2026-05-28T00:00:00Z'),
    )) {
      events.push({ source: evt.source, dedupKey: evt.dedupKey });
    }

    expect(events.length).toBe(3);
    expect(events[0]!.dedupKey).toContain('check_in');
    expect(events[1]!.dedupKey).toContain('tab_switch');
    expect(events[2]!.dedupKey).toContain('tab_switch');
  });
});
