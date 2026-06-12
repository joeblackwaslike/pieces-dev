import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Persistence } from '../services/persistence.js';

function mem(now?: () => number): Persistence {
	return new Persistence({ path: ':memory:', now });
}

describe('Persistence store', () => {
	test('runs a migration once and is idempotent when called again', () => {
		const store = mem().openStore('metrics');
		store.migrate(1, ['CREATE TABLE samples (ts INTEGER, cpu REAL)']);
		// Same version again must be a no-op, not re-run the CREATE (which would throw).
		store.migrate(1, ['CREATE TABLE samples (ts INTEGER, cpu REAL)']);
		store.run('INSERT INTO samples (ts, cpu) VALUES (?, ?)', 1000, 0.5);
		expect(store.all('SELECT * FROM samples')).toEqual([{ ts: 1000, cpu: 0.5 }]);
	});

	test('get returns a single row or undefined', () => {
		const s = mem().openStore('x');
		s.migrate(1, ['CREATE TABLE t (k TEXT, v INTEGER)']);
		s.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
		expect(s.get('SELECT v FROM t WHERE k = ?', 'a')).toEqual({ v: 1 });
		expect(s.get('SELECT v FROM t WHERE k = ?', 'missing')).toBeUndefined();
	});

	test('prune deletes rows older than the cutoff and returns the count', () => {
		const now = 10_000;
		const s = mem(() => now).openStore('log');
		s.migrate(1, ['CREATE TABLE entries (at INTEGER, msg TEXT)']);
		s.run('INSERT INTO entries (at, msg) VALUES (?, ?)', 1_000, 'old');
		s.run('INSERT INTO entries (at, msg) VALUES (?, ?)', 9_999, 'fresh');
		const removed = s.prune('entries', 'at', 5_000); // cutoff = now - 5000 = 5000
		expect(removed).toBe(1);
		expect(s.all('SELECT msg FROM entries')).toEqual([{ msg: 'fresh' }]);
	});

	test('creates the parent directory for a file-backed database', () => {
		const dir = join(tmpdir(), `pmon-persist-test-${process.pid}`);
		const file = join(dir, 'nested', 'db.sqlite');
		try {
			const s = new Persistence({ path: file }).openStore('t');
			s.migrate(1, ['CREATE TABLE x (v INTEGER)']);
			s.run('INSERT INTO x (v) VALUES (1)');
			expect(s.get('SELECT v FROM x')).toEqual({ v: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('migrations are tracked independently per namespace', () => {
		const p = mem();
		const a = p.openStore('a');
		const b = p.openStore('b');
		a.migrate(1, ['CREATE TABLE ta (x INTEGER)']);
		// Same version number in a different namespace must still run.
		b.migrate(1, ['CREATE TABLE tb (y INTEGER)']);
		a.run('INSERT INTO ta (x) VALUES (1)');
		b.run('INSERT INTO tb (y) VALUES (2)');
		expect(a.get('SELECT x FROM ta')).toEqual({ x: 1 });
		expect(b.get('SELECT y FROM tb')).toEqual({ y: 2 });
	});
});
