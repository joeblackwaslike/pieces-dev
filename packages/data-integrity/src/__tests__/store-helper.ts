import { DatabaseSync } from 'node:sqlite';
import type { SqlParam, StoreApi } from '@pieces-dev/monitor-sdk';

/** A real in-memory StoreApi (node:sqlite) so SQL is exercised for real, no monitor-core dep. */
export function memStore(): StoreApi {
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
		prune(table, tsColumn, olderThanMs) {
			const cutoff = Date.now() - olderThanMs;
			const info = db.prepare(`DELETE FROM ${table} WHERE ${tsColumn} < ?`).run(cutoff);
			return Number(info.changes);
		},
	};
}
