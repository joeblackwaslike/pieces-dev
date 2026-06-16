import { describe, expect, it, vi } from 'vitest';
import { GitLogSource } from '../sources/git-log.js';

// Mirror real `git log --name-only` output: a blank line between each commit
// header and its file list, and the next header following directly after the
// previous commit's files (no blank separator before it).
vi.mock('node:child_process', () => ({
	spawnSync: vi.fn().mockReturnValue({
		status: 0,
		error: undefined,
		stdout:
			'abc123|2026-05-27T14:00:00+00:00|Fix auth bug\n' +
			'\n' +
			'src/auth.ts\n' +
			'src/auth.test.ts\n' +
			'def456|2026-05-27T15:00:00+00:00|Add tests\n' +
			'\n' +
			'src/new.test.ts\n',
	}),
}));

describe('GitLogSource', () => {
	it('produces check_in and tab_switch events across commits, including file context after the header blank line', async () => {
		const source = new GitLogSource(['/Users/joe/project']);
		const events: Array<{ source: string; dedupKey: string }> = [];

		for await (const evt of source.collect(
			new Date('2026-05-27T00:00:00Z'),
			new Date('2026-05-28T00:00:00Z'),
		)) {
			events.push({ source: evt.source, dedupKey: evt.dedupKey });
		}

		// commit1 check_in + 2 files, commit2 check_in + 1 file
		expect(events.map((e) => e.dedupKey.split(':')[0])).toEqual([
			'check_in',
			'tab_switch',
			'tab_switch',
			'check_in',
			'tab_switch',
		]);
	});

	it('skips a repo cleanly when git exits non-zero', async () => {
		const { spawnSync } = await import('node:child_process');
		vi.mocked(spawnSync).mockReturnValueOnce({
			status: 128,
			error: undefined,
			stdout: '',
			// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
		} as any);

		const source = new GitLogSource(['/nope']);
		const events = [];
		for await (const evt of source.collect(
			new Date('2026-05-27T00:00:00Z'),
			new Date('2026-05-28T00:00:00Z'),
		)) {
			events.push(evt);
		}
		expect(events).toEqual([]);
	});
});
