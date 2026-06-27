import type { HealthState } from '@pieces-dev/monitor-sdk';

const RANK: Record<HealthState, number> = { ok: 0, warn: 1, crit: 2 };

/** Worst-of rollup across health states (empty → ok). */
export function worst(states: HealthState[]): HealthState {
	return states.reduce<HealthState>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), 'ok');
}

export interface CollapseResult {
	collapsed: boolean;
	dropRatio: number;
	state: HealthState;
}

/**
 * Size collapse vs baseline — the headline alarm. Trips only when the live file
 * is both proportionally (`collapseRatio`) and absolutely (`minCollapseBytes`)
 * smaller than the last-known-good baseline, so legitimate small shrinks and
 * pre-baseline (baseline 0) states never fire.
 */
export function evalSizeCollapse(
	bytes: number,
	baselineBytes: number,
	collapseRatio: number,
	minCollapseBytes: number,
): CollapseResult {
	if (baselineBytes <= 0) return { collapsed: false, dropRatio: 0, state: 'ok' };
	const drop = baselineBytes - bytes;
	const dropRatio = drop / baselineBytes;
	const collapsed = bytes < baselineBytes * (1 - collapseRatio) && drop > minCollapseBytes;
	return { collapsed, dropRatio, state: collapsed ? 'crit' : 'ok' };
}

/** WAL backlog: large WAL, or a WAL that keeps growing while the main file doesn't. */
export function evalWal(
	walBytes: number,
	walWarnBytes: number,
	walCritBytes: number,
	growingWithoutMain: boolean,
): { state: HealthState } {
	if (walBytes > walCritBytes || growingWithoutMain) return { state: 'crit' };
	if (walBytes > walWarnBytes) return { state: 'warn' };
	return { state: 'ok' };
}

/**
 * Freshness — "is capture alive?". Only meaningful when the gate is active
 * (Pieces up + authed + user not idle); an unknown age never alarms.
 */
export function evalFreshness(
	ageMinutes: number | null,
	gateActive: boolean,
	warnMinutes: number,
	critMinutes: number,
): { state: HealthState; ageMinutes: number | null } {
	if (ageMinutes === null || !gateActive) return { state: 'ok', ageMinutes };
	if (ageMinutes >= critMinutes) return { state: 'crit', ageMinutes };
	if (ageMinutes >= warnMinutes) return { state: 'warn', ageMinutes };
	return { state: 'ok', ageMinutes };
}

/** Latency on a constant-cost probe — rising means contention, not a bigger DB. */
export function evalLatency(
	latencyMs: number,
	warnMs: number,
	critMs: number,
): { state: HealthState } {
	if (latencyMs >= critMs) return { state: 'crit' };
	if (latencyMs >= warnMs) return { state: 'warn' };
	return { state: 'ok' };
}

/** Sequence-gap corruption proxy: rollback, or advancing seqno with a falling count. */
export function evalSeqno(
	maxSeqno: number | null,
	count: number | null,
	prevMaxSeqno: number | null,
	prevCount: number | null,
): { suspect: boolean } {
	if (maxSeqno === null || prevMaxSeqno === null) return { suspect: false };
	if (maxSeqno < prevMaxSeqno) return { suspect: true };
	if (count !== null && prevCount !== null && maxSeqno > prevMaxSeqno && count < prevCount) {
		return { suspect: true };
	}
	return { suspect: false };
}

/** Integrity-check result. The couchbase FTS-tokenizer limitation is not corruption. */
export function evalIntegrity(integrity: string): { state: HealthState; corrupt: boolean } {
	if (integrity === 'ok' || integrity.startsWith('unavailable')) {
		return { state: 'ok', corrupt: false };
	}
	return { state: 'crit', corrupt: true };
}
