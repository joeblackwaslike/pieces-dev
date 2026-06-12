import type { Command } from '@pieces-dev/monitor-sdk';
import type { DataIntegrityEngine } from './engine.js';

/** The `pmon data` verbs — also menu items and dashboard actions. */
export function buildCommands(engine: DataIntegrityEngine): Command[] {
	return [
		{
			id: 'data.status',
			title: 'Data Integrity Status',
			handler: () => engine.snapshot(),
		},
		{
			id: 'data.check',
			title: 'Check Data Integrity Now',
			async: true,
			expectedDurationMs: 5_000,
			params: [
				{ key: 'db', label: 'Database id (optional)', type: 'string', default: '' },
			],
			handler: (params) => {
				const db = params?.db ? String(params.db) : undefined;
				return engine.sweep({ deep: true, ...(db ? { onlyId: db } : {}) });
			},
		},
		{
			id: 'data.pin-baseline',
			title: 'Pin Current State as Known-Good',
			params: [{ key: 'db', label: 'Database id', type: 'string', default: '' }],
			handler: (params) => ({ pinned: engine.pinBaseline(String(params?.db ?? '')) }),
		},
	];
}
