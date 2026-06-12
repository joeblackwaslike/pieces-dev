import type { HealthState, StoreApi } from '@pieces-dev/monitor-sdk';
import type { DbSample } from './types.js';

interface HistoryRow {
	id: string;
	ts: number;
	bytes: number;
	wal_bytes: number;
	shm_present: number;
	max_seqno: number | null;
	count: number | null;
	age_minutes: number | null;
	latency_ms: number;
	integrity: string | null;
	status: string;
}

export interface HistoryStore {
	append(sample: DbSample): void;
	latest(id: string): DbSample | null;
	recent(id: string, limit: number): DbSample[];
	prune(olderThanMs: number): number;
}

function toSample(row: HistoryRow): DbSample {
	return {
		id: row.id,
		ts: row.ts,
		bytes: row.bytes,
		walBytes: row.wal_bytes,
		shmPresent: row.shm_present !== 0,
		maxSeqno: row.max_seqno,
		count: row.count,
		ageMinutes: row.age_minutes,
		latencyMs: row.latency_ms,
		integrity: row.integrity,
		status: row.status as HealthState,
	};
}

export function createHistoryStore(store: StoreApi): HistoryStore {
	// Version 2: baseline owns version 1 in this same (shared) extension namespace.
	store.migrate(2, [
		`CREATE TABLE history (
			id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			bytes INTEGER NOT NULL,
			wal_bytes INTEGER NOT NULL,
			shm_present INTEGER NOT NULL,
			max_seqno INTEGER,
			count INTEGER,
			age_minutes REAL,
			latency_ms REAL NOT NULL,
			integrity TEXT,
			status TEXT NOT NULL
		)`,
		`CREATE INDEX history_id_ts ON history (id, ts)`,
	]);

	return {
		append(s) {
			store.run(
				`INSERT INTO history (id, ts, bytes, wal_bytes, shm_present, max_seqno, count, age_minutes, latency_ms, integrity, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				s.id,
				s.ts,
				s.bytes,
				s.walBytes,
				s.shmPresent ? 1 : 0,
				s.maxSeqno,
				s.count,
				s.ageMinutes,
				s.latencyMs,
				s.integrity,
				s.status,
			);
		},
		latest(id) {
			const row = store.get<HistoryRow>(
				'SELECT * FROM history WHERE id = ? ORDER BY ts DESC LIMIT 1',
				id,
			);
			return row ? toSample(row) : null;
		},
		recent(id, limit) {
			return store
				.all<HistoryRow>('SELECT * FROM history WHERE id = ? ORDER BY ts DESC LIMIT ?', id, limit)
				.map(toSample);
		},
		prune(olderThanMs) {
			return store.prune('history', 'ts', olderThanMs);
		},
	};
}
