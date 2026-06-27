import type { DbSample } from './types.js';

const MB = 1_048_576;

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/** Compact "is capture alive?" tile — last workstream event N minutes ago. */
export function renderFreshness(sample: DbSample | null): string {
	if (!sample || sample.ageMinutes === null) {
		return `<div class="freshness unknown">Last event: unknown</div>`;
	}
	const state = sample.status;
	return `<div class="freshness ${state}">Last event ${sample.ageMinutes.toFixed(0)} min ago</div>`;
}

/** Per-DB table: id, status, live size, WAL, max seqno, last event age, latency, integrity. */
export function renderDataTable(samples: DbSample[]): string {
	if (samples.length === 0) return `<p class="empty">No databases monitored yet.</p>`;
	const rows = samples
		.map((s) => {
			const cells = [
				escapeHtml(s.id),
				s.status,
				mb(s.bytes),
				mb(s.walBytes),
				s.maxSeqno ?? '—',
				s.ageMinutes === null ? '—' : `${s.ageMinutes.toFixed(0)}m`,
				`${s.latencyMs.toFixed(0)}ms`,
				escapeHtml(s.integrity ?? '—'),
			];
			return `<tr class="${s.status}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
		})
		.join('');
	return `<table class="data-integrity"><thead><tr><th>DB</th><th>Status</th><th>Size</th><th>WAL</th><th>Seqno</th><th>Age</th><th>Latency</th><th>Integrity</th></tr></thead><tbody>${rows}</tbody></table>`;
}
