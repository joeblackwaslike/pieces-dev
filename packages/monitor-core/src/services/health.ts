import type { HealthApi, HealthReport, HealthState, OverallStatus } from '@pieces-dev/monitor-sdk';

const RANK: Record<HealthState, number> = { ok: 0, warn: 1, crit: 2 };

/**
 * The health rollup: extensions report per-check status; the daemon aggregates
 * to one worst-of overall status that drives the menu-bar color, dashboard
 * banner, and CLI exit code.
 */
export class Health {
	private readonly reports = new Map<string, HealthReport>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	forExtension(source: string): HealthApi {
		return {
			report: (checkId, state, detail) => {
				const report: HealthReport = { checkId, state, at: this.now() };
				if (detail !== undefined) report.detail = detail;
				// `source` is retained implicitly via the namespaced checkId convention.
				void source;
				this.reports.set(checkId, report);
			},
		};
	}

	overall(): OverallStatus {
		const checks = [...this.reports.values()];
		let state: HealthState = 'ok';
		for (const check of checks) {
			if (RANK[check.state] > RANK[state]) state = check.state;
		}
		return { state, checks, at: this.now() };
	}
}
