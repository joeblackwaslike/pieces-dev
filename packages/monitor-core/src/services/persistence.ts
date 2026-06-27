import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlParam, StoreApi } from '@pieces-dev/monitor-sdk';

export interface PersistenceOptions {
	/** SQLite file path, or `:memory:` (default) for tests. */
	path?: string;
	/** Injectable clock (epoch ms) for deterministic tests. */
	now?: () => number;
}

/**
 * The persistence service: a thin shim over a single SQLite database (the
 * built-in `node:sqlite`). Hands out one {@link StoreApi} per namespace
 * (extension id or core service name); migrations are tracked per namespace so
 * the same version can be reused by each.
 */
export class Persistence {
	private readonly db: DatabaseSync;
	private readonly now: () => number;

	constructor(options: PersistenceOptions = {}) {
		const path = options.path ?? ':memory:';
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec('PRAGMA journal_mode = WAL');
		this.now = options.now ?? Date.now;
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS _migrations (
				namespace TEXT NOT NULL,
				version INTEGER NOT NULL,
				applied_at INTEGER NOT NULL,
				PRIMARY KEY (namespace, version)
			)`,
		);
	}

	openStore(namespace: string): StoreApi {
		return new Store(this.db, namespace, this.now);
	}

	close(): void {
		this.db.close();
	}
}

class Store implements StoreApi {
	constructor(
		private readonly db: DatabaseSync,
		private readonly namespace: string,
		private readonly now: () => number,
	) {}

	migrate(version: number, statements: string[]): void {
		const applied = this.db
			.prepare('SELECT 1 FROM _migrations WHERE namespace = ? AND version = ?')
			.get(this.namespace, version);
		if (applied) return;
		this.db.exec('BEGIN');
		try {
			for (const sql of statements) this.db.exec(sql);
			this.db
				.prepare('INSERT INTO _migrations (namespace, version, applied_at) VALUES (?, ?, ?)')
				.run(this.namespace, version, this.now());
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	run(sql: string, ...params: SqlParam[]): void {
		this.db.prepare(sql).run(...params);
	}

	get<T = unknown>(sql: string, ...params: SqlParam[]): T | undefined {
		return this.db.prepare(sql).get(...params) as T | undefined;
	}

	all<T = unknown>(sql: string, ...params: SqlParam[]): T[] {
		return this.db.prepare(sql).all(...params) as T[];
	}

	prune(table: string, tsColumn: string, olderThanMs: number): number {
		const cutoff = this.now() - olderThanMs;
		const info = this.db.prepare(`DELETE FROM "${table}" WHERE "${tsColumn}" < ?`).run(cutoff);
		return Number(info.changes);
	}
}
