import type { HealthState } from '@pieces-dev/monitor-sdk';

export type DbKind = 'couchbase-lite' | 'sqlite';

/** A monitored database, expanded from a glob relative to the Pieces data dir. */
export interface DbConfig {
	id: string;
	glob: string;
	kind: DbKind;
	critical: boolean;
	enabled: boolean;
}

/** One resolved file on disk that a {@link DbConfig} glob matched. */
export interface DbFile {
	id: string;
	path: string;
	kind: DbKind;
	critical: boolean;
}

/** Where decode-free freshness (seqno-advance) is read from. */
export interface FreshnessSource {
	dbId: string;
	/** Couchbase collection table holding workstream events (sequence column). */
	table: string;
}

/** A single sweep sample for one DB, persisted to bounded history. */
export interface DbSample {
	id: string;
	ts: number;
	bytes: number;
	walBytes: number;
	shmPresent: boolean;
	maxSeqno: number | null;
	count: number | null;
	ageMinutes: number | null;
	latencyMs: number;
	integrity: string | null;
	status: HealthState;
}

/** Last-known-good reference for a DB; ratchets upward only. */
export interface Baseline {
	id: string;
	baselineBytes: number;
	baselineMaxSeqno: number | null;
	baselineCount: number | null;
	pinnedAt: number;
	pinnedReason: string;
}

export type SuspectReason = 'corruption' | 'collapse' | 'missing';
