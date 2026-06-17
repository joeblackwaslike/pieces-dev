import type { StoreApi } from '@pieces-dev/monitor-sdk';
import type { Baseline } from './types.js';

interface BaselineRow {
	id: string;
	baseline_bytes: number;
	baseline_max_seqno: number | null;
	baseline_count: number | null;
	pinned_at: number;
	pinned_reason: string;
}

export interface BaselineStore {
	load(id: string): Baseline | null;
	pin(baseline: Baseline): void;
	/** Raise the baseline if the file grew; collapse never lowers it. Returns the effective baseline. */
	ratchet(
		id: string,
		bytes: number,
		maxSeqno: number | null,
		count: number | null,
		now: number,
	): Baseline;
}

function toBaseline(row: BaselineRow): Baseline {
	return {
		id: row.id,
		baselineBytes: row.baseline_bytes,
		baselineMaxSeqno: row.baseline_max_seqno,
		baselineCount: row.baseline_count,
		pinnedAt: row.pinned_at,
		pinnedReason: row.pinned_reason,
	};
}

export function createBaselineStore(store: StoreApi): BaselineStore {
	store.migrate(1, [
		`CREATE TABLE baseline (
			id TEXT PRIMARY KEY,
			baseline_bytes INTEGER NOT NULL,
			baseline_max_seqno INTEGER,
			baseline_count INTEGER,
			pinned_at INTEGER NOT NULL,
			pinned_reason TEXT NOT NULL
		)`,
	]);

	const load = (id: string): Baseline | null => {
		const row = store.get<BaselineRow>('SELECT * FROM baseline WHERE id = ?', id);
		return row ? toBaseline(row) : null;
	};

	const pin = (b: Baseline): void => {
		store.run(
			`INSERT INTO baseline (id, baseline_bytes, baseline_max_seqno, baseline_count, pinned_at, pinned_reason)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				baseline_bytes = excluded.baseline_bytes,
				baseline_max_seqno = excluded.baseline_max_seqno,
				baseline_count = excluded.baseline_count,
				pinned_at = excluded.pinned_at,
				pinned_reason = excluded.pinned_reason`,
			b.id,
			b.baselineBytes,
			b.baselineMaxSeqno,
			b.baselineCount,
			b.pinnedAt,
			b.pinnedReason,
		);
	};

	return {
		load,
		pin,
		ratchet(id, bytes, maxSeqno, count, now) {
			const current = load(id);
			if (current && bytes <= current.baselineBytes) return current;
			const next: Baseline = {
				id,
				baselineBytes: bytes,
				baselineMaxSeqno: maxSeqno,
				baselineCount: count,
				pinnedAt: now,
				pinnedReason: current ? 'ratchet-up' : 'initial-pin',
			};
			pin(next);
			return next;
		},
	};
}

/**
 * Whether a first-run baseline may be auto-pinned. Refuses to canonize a DB that
 * is corrupt, stale-while-active, empty, or unauthed — which is how a monitor
 * installed *after* a collapse would look.
 */
export function canAutoPin(opts: {
	bytes: number;
	integrityCrit: boolean;
	freshnessCrit: boolean;
	piecesAuthed: boolean;
}): boolean {
	return opts.bytes > 0 && !opts.integrityCrit && !opts.freshnessCrit && opts.piecesAuthed;
}
