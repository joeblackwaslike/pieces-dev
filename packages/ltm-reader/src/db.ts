import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { decodeFleeceToJSON, parseFleeceArray } from './fleece.js';

const DEFAULT_DB_PATH = join(
	homedir(),
	'Library/com.pieces.os/production/Pieces/couchbase.cblite2/db.sqlite3',
);

export interface LtmReaderOptions {
	dbPath?: string;
}

const COLLECTIONS = {
	workstreamEvents: 'kv_.workstream\\Events',
	workstreamSummaries: 'kv_.workstream\\Summaries',
	annotations: 'kv_.annotations',
	hints: 'kv_.hints',
	tags: 'kv_.tags',
	persons: 'kv_.persons',
	websites: 'kv_.websites',
	anchors: 'kv_.anchors',
	anchorPoints: 'kv_.anchor\\Points',
	wpeSources: 'kv_.workstream\\Pattern\\Engine\\Sources',
	wpeSourceWindows: 'kv_.workstream\\Pattern\\Engine\\Source\\Windows',
} as const;

export type CollectionName = keyof typeof COLLECTIONS;

export class LtmReader {
	private db: SqlJsDatabase | null = null;
	private dbPath: string;
	private initPromise: Promise<void> | null = null;
	private sharedKeys: string[] = [];

	constructor(options: LtmReaderOptions = {}) {
		this.dbPath = options.dbPath ?? DEFAULT_DB_PATH;
		if (!existsSync(this.dbPath)) {
			throw new Error(`Pieces database not found at: ${this.dbPath}`);
		}
	}

	private async ensureOpen(): Promise<SqlJsDatabase> {
		if (this.db) return this.db;
		if (!this.initPromise) {
			this.initPromise = (async () => {
				const SQL = await initSqlJs();
				const buffer = readFileSync(this.dbPath);
				this.db = new SQL.Database(buffer);
				this.loadSharedKeys();
			})().catch((err) => {
				// Clear the cached promise so a later call can retry instead of
				// being stuck with a permanently rejected promise.
				this.initPromise = null;
				throw err;
			});
		}
		await this.initPromise;
		return this.db!;
	}

	private loadSharedKeys() {
		if (!this.db) return;
		const result = this.db.exec('SELECT body FROM kv_info WHERE key = "SharedKeys"');
		const blob = result[0]?.values[0]?.[0];
		if (blob instanceof Uint8Array) {
			this.sharedKeys = parseFleeceArray(Buffer.from(blob));
		}
	}

	private decode(body: Uint8Array | null): unknown {
		if (!body) return null;
		return decodeFleeceToJSON(Buffer.from(body), this.sharedKeys);
	}

	async count(collection: CollectionName): Promise<number> {
		const db = await this.ensureOpen();
		const table = COLLECTIONS[collection];
		const result = db.exec(`SELECT COUNT(*) FROM "${table}"`);
		return (result[0]?.values[0]?.[0] as number) ?? 0;
	}

	async getDocument(collection: CollectionName, key: string): Promise<unknown | null> {
		const db = await this.ensureOpen();
		const table = COLLECTIONS[collection];
		const stmt = db.prepare(`SELECT body FROM "${table}" WHERE key = ?`);
		stmt.bind([key]);
		if (!stmt.step()) {
			stmt.free();
			return null;
		}
		const row = stmt.get();
		stmt.free();
		return this.decode(row[0] as Uint8Array | null);
	}

	async listKeys(collection: CollectionName, limit = 100, offset = 0): Promise<string[]> {
		const db = await this.ensureOpen();
		const table = COLLECTIONS[collection];
		const result = db.exec(
			`SELECT key FROM "${table}" ORDER BY sequence DESC LIMIT ${limit} OFFSET ${offset}`,
		);
		if (!result[0]) return [];
		return result[0].values.map((row) => row[0] as string);
	}

	async getAllDocuments(
		collection: CollectionName,
		limit = 100,
		offset = 0,
	): Promise<Array<{ key: string; sequence: number; data: unknown }>> {
		const db = await this.ensureOpen();
		const table = COLLECTIONS[collection];
		const result = db.exec(
			`SELECT key, sequence, body FROM "${table}" ORDER BY sequence DESC LIMIT ${limit} OFFSET ${offset}`,
		);
		if (!result[0]) return [];
		return result[0].values.map((row) => ({
			key: row[0] as string,
			sequence: row[1] as number,
			data: this.decode(row[2] as Uint8Array | null),
		}));
	}

	async stats(): Promise<Record<CollectionName, number>> {
		const result = {} as Record<CollectionName, number>;
		for (const name of Object.keys(COLLECTIONS) as CollectionName[]) {
			try {
				result[name] = await this.count(name);
			} catch {
				result[name] = -1;
			}
		}
		return result;
	}

	close() {
		if (this.db) {
			this.db.close();
			this.db = null;
			this.initPromise = null;
		}
	}
}
