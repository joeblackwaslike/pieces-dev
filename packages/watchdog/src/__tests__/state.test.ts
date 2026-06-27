import { DatabaseSync } from 'node:sqlite';
import type { SqlParam, StoreApi } from '@pieces-dev/monitor-sdk';
import { describe, expect, test } from 'vitest';
import { createStatePersistence } from '../state.js';

/** A real (in-memory) StoreApi so the SQL is exercised for real, no monitor-core dep. */
function memStore(): StoreApi {
	const db = new DatabaseSync(':memory:');
	const applied = new Set<number>();
	return {
		migrate(version, statements) {
			if (applied.has(version)) return;
			for (const sql of statements) db.exec(sql);
			applied.add(version);
		},
		run(sql, ...params) {
			db.prepare(sql).run(...(params as SqlParam[]));
		},
		get<T = unknown>(sql: string, ...params: SqlParam[]) {
			return db.prepare(sql).get(...params) as T | undefined;
		},
		all<T = unknown>(sql: string, ...params: SqlParam[]) {
			return db.prepare(sql).all(...params) as T[];
		},
		prune() {
			return 0;
		},
	};
}

describe('watchdog persisted state', () => {
	test('load returns sane defaults on a fresh store', () => {
		const state = createStatePersistence(memStore()).load();
		expect(state).toEqual({
			restartCount: 0,
			lastCleanTime: 0,
			gaveUp: false,
			gaveUpAt: 0,
			authLoggedIn: true,
		});
	});

	test('save persists a partial patch and load reads it back', () => {
		const persistence = createStatePersistence(memStore());
		persistence.save({ restartCount: 3, lastCleanTime: 12345, authLoggedIn: false });
		expect(persistence.load()).toEqual({
			restartCount: 3,
			lastCleanTime: 12345,
			gaveUp: false,
			gaveUpAt: 0,
			authLoggedIn: false,
		});
	});

	test('booleans round-trip through integer columns', () => {
		const persistence = createStatePersistence(memStore());
		persistence.save({ gaveUp: true, gaveUpAt: 999 });
		const state = persistence.load();
		expect(state.gaveUp).toBe(true);
		expect(state.gaveUpAt).toBe(999);
	});

	test('a second persistence over the same store sees the migration already applied', () => {
		const store = memStore();
		createStatePersistence(store).save({ restartCount: 7 });
		// Re-wrapping must not re-run the INSERT (would violate the PK) nor wipe state.
		expect(createStatePersistence(store).load().restartCount).toBe(7);
	});
});
