import type { LogApi, LogEntry, LogLevel, LogQuery, SqlParam, StoreApi } from '@pieces-dev/monitor-sdk';

interface Row {
	level: string;
	source: string;
	message: string;
	data: string;
	at: number;
}

/**
 * The log service: structured, queryable per-extension logs persisted via the
 * persistence service. Complements incidents (incidents = headlines, logs =
 * verbose stream).
 */
export class Log {
	constructor(
		private readonly store: StoreApi,
		private readonly now: () => number = Date.now,
	) {
		store.migrate(1, [
			`CREATE TABLE logs (
				level TEXT NOT NULL,
				source TEXT NOT NULL,
				message TEXT NOT NULL,
				data TEXT NOT NULL,
				at INTEGER NOT NULL
			)`,
			'CREATE INDEX idx_logs_at ON logs (at)',
		]);
	}

	forExtension(source: string): LogApi {
		const write = (level: LogLevel, message: string, data?: unknown) => {
			this.store.run(
				'INSERT INTO logs (level, source, message, data, at) VALUES (?, ?, ?, ?, ?)',
				level,
				source,
				message,
				JSON.stringify(data ?? null),
				this.now(),
			);
		};
		return {
			debug: (message, data) => write('debug', message, data),
			info: (message, data) => write('info', message, data),
			warn: (message, data) => write('warn', message, data),
			error: (message, data) => write('error', message, data),
			query: (query) => this.query(query),
		};
	}

	private query(query: LogQuery = {}): LogEntry[] {
		const where: string[] = [];
		const params: SqlParam[] = [];
		if (query.source !== undefined) {
			where.push('source = ?');
			params.push(query.source);
		}
		if (query.level !== undefined) {
			where.push('level = ?');
			params.push(query.level);
		}
		if (query.since !== undefined) {
			where.push('at >= ?');
			params.push(query.since);
		}
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const limit = query.limit !== undefined ? `LIMIT ${Number(query.limit)}` : '';
		const rows = this.store.all<Row>(
			`SELECT * FROM logs ${clause} ORDER BY at DESC, rowid DESC ${limit}`,
			...params,
		);
		return rows.map(toEntry);
	}
}

function toEntry(row: Row): LogEntry {
	const entry: LogEntry = {
		level: row.level as LogLevel,
		source: row.source,
		message: row.message,
		at: row.at,
	};
	const data = JSON.parse(row.data);
	if (data !== null) entry.data = data;
	return entry;
}
