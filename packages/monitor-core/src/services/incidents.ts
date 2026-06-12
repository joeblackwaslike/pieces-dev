import { randomUUID } from 'node:crypto';
import type { Incident, IncidentApi, IncidentQuery, SqlParam, StoreApi } from '@pieces-dev/monitor-sdk';

interface Row {
	id: string;
	source: string;
	kind: string;
	severity: string;
	summary: string;
	data: string;
	at: number;
}

/**
 * The incident store: structured, queryable "when & why" records, persisted via
 * the persistence service. Each extension records under its own source.
 */
export class Incidents {
	constructor(
		private readonly store: StoreApi,
		private readonly now: () => number = Date.now,
		private readonly nextId: () => string = randomUUID,
	) {
		store.migrate(1, [
			`CREATE TABLE incidents (
				id TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				kind TEXT NOT NULL,
				severity TEXT NOT NULL,
				summary TEXT NOT NULL,
				data TEXT NOT NULL,
				at INTEGER NOT NULL
			)`,
			'CREATE INDEX idx_incidents_at ON incidents (at)',
		]);
	}

	forExtension(source: string): IncidentApi {
		return {
			record: (input) => {
				const incident: Incident = {
					id: this.nextId(),
					source,
					at: this.now(),
					...input,
				};
				this.store.run(
					'INSERT INTO incidents (id, source, kind, severity, summary, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
					incident.id,
					source,
					input.kind,
					input.severity,
					input.summary,
					JSON.stringify(input.data ?? null),
					incident.at,
				);
				return incident;
			},
			query: (query) => this.query(query),
		};
	}

	private query(query: IncidentQuery = {}): Incident[] {
		const where: string[] = [];
		const params: SqlParam[] = [];
		if (query.source !== undefined) {
			where.push('source = ?');
			params.push(query.source);
		}
		if (query.kind !== undefined) {
			where.push('kind = ?');
			params.push(query.kind);
		}
		if (query.since !== undefined) {
			where.push('at >= ?');
			params.push(query.since);
		}
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const limit = query.limit !== undefined ? `LIMIT ${Number(query.limit)}` : '';
		const rows = this.store.all<Row>(
			`SELECT * FROM incidents ${clause} ORDER BY at DESC, rowid DESC ${limit}`,
			...params,
		);
		return rows.map(toIncident);
	}
}

function toIncident(row: Row): Incident {
	const incident: Incident = {
		id: row.id,
		source: row.source,
		kind: row.kind,
		severity: row.severity as Incident['severity'],
		summary: row.summary,
		at: row.at,
	};
	const data = JSON.parse(row.data);
	if (data !== null) incident.data = data;
	return incident;
}
