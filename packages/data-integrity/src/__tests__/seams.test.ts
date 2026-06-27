import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { expandGlob, statFile, walInfo } from '../fs.js';
import { idleSeconds, parseHidIdle } from '../idle.js';
import { isCouchbaseFtsError, probe } from '../sqlite.js';

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'di-seams-'));
	// a couchbase-ish dir + a workstream db + WAL siblings
	writeFileSync(join(dir, 'hints.sqlite'), 'x'.repeat(2048));
	writeFileSync(join(dir, 'hints.sqlite-wal'), 'y'.repeat(4096));
	writeFileSync(join(dir, 'workstream.archive.sqlite'), 'z'.repeat(100));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('fs seam', () => {
	test('statFile reports size for an existing file and absence for a missing one', () => {
		expect(statFile(join(dir, 'hints.sqlite'))).toEqual({ exists: true, bytes: 2048 });
		expect(statFile(join(dir, 'nope.sqlite'))).toEqual({ exists: false, bytes: 0 });
	});

	test('walInfo reports the -wal size and -shm presence', () => {
		const info = walInfo(join(dir, 'hints.sqlite'));
		expect(info.walBytes).toBe(4096);
		expect(info.shmPresent).toBe(false);
	});

	test('expandGlob resolves literal and wildcard globs to absolute paths', () => {
		expect(expandGlob(dir, 'hints.sqlite')).toEqual([join(dir, 'hints.sqlite')]);
		expect(expandGlob(dir, 'workstream*.sqlite')).toContain(join(dir, 'workstream.archive.sqlite'));
		expect(expandGlob(dir, 'missing*.sqlite')).toEqual([]);
	});
});

describe('idle seam', () => {
	test('parseHidIdle converts HIDIdleTime nanoseconds to seconds', () => {
		expect(parseHidIdle('| | |   "HIDIdleTime" = 189525375000')).toBeCloseTo(189.5, 0);
	});
	test('parseHidIdle returns null when the field is absent', () => {
		expect(parseHidIdle('no field here')).toBeNull();
	});
	test('idleSeconds uses the injected runner', () => {
		const run = () => '"HIDIdleTime" = 5000000000';
		expect(idleSeconds(run)).toBeCloseTo(5, 5);
	});
	test('idleSeconds returns 0 when the runner throws', () => {
		const run = () => {
			throw new Error('no ioreg');
		};
		expect(idleSeconds(run)).toBe(0);
	});
});

describe('sqlite seam', () => {
	let dbPath: string;
	beforeAll(() => {
		dbPath = join(dir, 'probe.sqlite');
		const db = new DatabaseSync(dbPath);
		db.exec('CREATE TABLE events (key TEXT, sequence INTEGER)');
		db.exec("INSERT INTO events VALUES ('a', 1), ('b', 2), ('c', 5)");
		db.close();
	});

	test('probe reads page_count, max sequence, count, and a clean integrity check', () => {
		const r = probe(dbPath, { table: 'events', deepIntegrity: true });
		expect(r.opened).toBe(true);
		expect(r.pageCount).toBeGreaterThan(0);
		expect(r.maxSeqno).toBe(5);
		expect(r.count).toBe(3);
		expect(r.integrity).toBe('ok');
		expect(r.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test('probe without deepIntegrity leaves integrity null', () => {
		expect(probe(dbPath, { table: 'events' }).integrity).toBeNull();
	});

	test('probe of a missing file does not throw and reports not opened', () => {
		const r = probe(join(dir, 'ghost.sqlite'), { deepIntegrity: true });
		expect(r.opened).toBe(false);
		expect(r.maxSeqno).toBeNull();
	});

	test('isCouchbaseFtsError recognises the unicodesn tokenizer error', () => {
		expect(isCouchbaseFtsError(new Error('unknown tokenizer: unicodesn'))).toBe(true);
		expect(isCouchbaseFtsError(new Error('disk I/O error'))).toBe(false);
	});
});
