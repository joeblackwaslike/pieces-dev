import type { HealthState, Incident, OverallStatus } from '@pieces-dev/monitor-sdk';

const EXIT: Record<HealthState, number> = { ok: 0, warn: 1, crit: 2 };

/** Map an overall health state to a process exit code (ok=0, warn=1, crit=2). */
export function statusExitCode(state: HealthState): number {
	return EXIT[state];
}

export function renderStatus(status: OverallStatus): string {
	const lines = [`overall: ${status.state.toUpperCase()}`];
	if (status.checks.length === 0) {
		lines.push('  (no checks reported)');
	}
	for (const check of [...status.checks].sort((a, b) => a.checkId.localeCompare(b.checkId))) {
		const detail = check.detail ? ` — ${check.detail}` : '';
		lines.push(`  [${check.state}] ${check.checkId}${detail}`);
	}
	return lines.join('\n');
}

export function renderIncidents(incidents: Incident[]): string {
	if (incidents.length === 0) return 'No incidents recorded.';
	return incidents
		.map(
			(i) =>
				`${new Date(i.at).toISOString()} [${i.severity}] ${i.kind} — ${i.summary} (${i.source})`,
		)
		.join('\n');
}
