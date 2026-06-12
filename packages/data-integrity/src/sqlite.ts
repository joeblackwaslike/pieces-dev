import { DatabaseSync } from 'node:sqlite';

export interface DbProbe {
	opened: boolean;
	pageCount: number | null;
	latencyMs: number;
	integrity: string | null;
	maxSeqno: number | null;
	count: number | null;
}

export interface ProbeOptions {
	/** Sequence-bearing table to read MAX(sequence)/COUNT(*) from. */
	table?: string;
	/** Run PRAGMA quick_check (skipped for cheap routine sweeps). */
	deepIntegrity?: boolean;
	now?: () => number;
}

/** Couchbase Lite registers a custom FTS tokenizer plain SQLite lacks; integrity scans hit it. */
export function isCouchbaseFtsError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.includes('unicodesn') || message.includes('unknown tokenizer');
}

function quickCheck(db: DatabaseSync): string | null {
	try {
		const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
		if (rows.length === 1 && rows[0]?.quick_check === 'ok') return 'ok';
		return rows.map((r) => r.quick_check).join('\n');
	} catch (err) {
		// The couchbase tokenizer gap is a known limitation, not corruption; any other
		// read error means "couldn't check", which the engine treats as no signal.
		return isCouchbaseFtsError(err) ? 'unavailable (couchbase-fts)' : null;
	}
}

/**
 * Read-only, WAL-consistent probe of a SQLite database. Times the constant-cost
 * `PRAGMA page_count` as the latency signal, optionally reads sequence/count and
 * runs a deep integrity check. Never throws — a missing/locked file returns
 * `opened: false` with null signals.
 */
export function probe(path: string, opts: ProbeOptions = {}): DbProbe {
	const now = opts.now ?? (() => Date.now());
	const result: DbProbe = {
		opened: false,
		pageCount: null,
		latencyMs: 0,
		integrity: null,
		maxSeqno: null,
		count: null,
	};
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		result.opened = true;
		const t0 = now();
		const pc = db.prepare('PRAGMA page_count').get() as { page_count: number } | undefined;
		result.latencyMs = now() - t0;
		result.pageCount = pc?.page_count ?? null;

		if (opts.table) {
			try {
				const row = db
					.prepare(`SELECT MAX(sequence) AS m, COUNT(*) AS c FROM "${opts.table}"`)
					.get() as { m: number | null; c: number } | undefined;
				result.maxSeqno = row?.m ?? null;
				result.count = row?.c ?? null;
			} catch {
				// Table absent or unreadable — leave seqno/count null.
			}
		}
		if (opts.deepIntegrity) result.integrity = quickCheck(db);
	} catch {
		// Open failed (missing/locked) — opened stays false.
	} finally {
		db?.close();
	}
	return result;
}
