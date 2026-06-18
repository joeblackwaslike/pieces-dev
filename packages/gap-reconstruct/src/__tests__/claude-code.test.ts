import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeSource, decodeProjectDir } from '../sources/claude-code.js';

describe('ClaudeCodeSource', () => {
	it('extracts file events from JSONL session', async () => {
		const source = new ClaudeCodeSource(new URL('./fixtures/', import.meta.url).pathname);

		const events: Array<{ timestamp: Date; source: string; dedupKey: string }> = [];
		const from = new Date('2026-05-27T00:00:00Z');
		const to = new Date('2026-05-28T00:00:00Z');

		for await (const evt of source.collect(from, to)) {
			events.push({
				timestamp: evt.timestamp,
				source: evt.source,
				dedupKey: evt.dedupKey,
			});
		}

		expect(events.length).toBeGreaterThan(0);
		expect(events.every((e) => e.source === 'claude')).toBe(true);
		expect(events.some((e) => e.dedupKey.includes('file_open'))).toBe(true);
	});

	it('skips events outside the time window', async () => {
		const source = new ClaudeCodeSource(new URL('./fixtures/', import.meta.url).pathname);

		const events: unknown[] = [];
		const from = new Date('2026-06-01T00:00:00Z');
		const to = new Date('2026-06-02T00:00:00Z');

		for await (const evt of source.collect(from, to)) {
			events.push(evt);
		}

		expect(events.length).toBe(0);
	});
});

describe('decodeProjectDir', () => {
	it('preserves hyphens in project names by probing the filesystem', () => {
		// Regression: naive `replace(/-/g, sep)` decoded `pieces-dev` to
		// `pieces${sep}dev`. The FS probe must keep the hyphen intact.
		const base = realpathSync(mkdtempSync(join(tmpdir(), 'gr-')));
		const projectDir = join(base, 'pieces-dev');
		mkdirSync(projectDir);
		try {
			const encoded = projectDir.split(sep).join('-');
			expect(decodeProjectDir(encoded)).toBe(projectDir);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it('falls back to naive decode when nothing on disk matches', () => {
		const encoded = '-nope-aaa-bbb-ccc';
		expect(decodeProjectDir(encoded)).toBe(`${sep}nope${sep}aaa${sep}bbb${sep}ccc`);
	});
});
