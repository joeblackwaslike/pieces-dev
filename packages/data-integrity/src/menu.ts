import type { HealthState, MenuItem, MenuSection } from '@pieces-dev/monitor-sdk';

const TINT: Record<HealthState, string> = { ok: '✓', warn: '!', crit: '✕' };

/** Build the menu-bar "Pieces Data" section from the per-DB snapshot. */
export function buildMenuSection(
	snapshot: Array<{ id: string; status: HealthState; suspect: boolean }>,
): MenuSection {
	const rows: MenuItem[] = snapshot.map((db) => ({
		label: `${TINT[db.status]} ${db.id}${db.suspect ? ' (suspect)' : ''}`,
		enabled: false,
	}));
	rows.push({
		label: 'Re-check Data Integrity',
		action: { type: 'run-command', commandId: 'data.check' },
	});
	return { title: 'Pieces Data', items: rows };
}
