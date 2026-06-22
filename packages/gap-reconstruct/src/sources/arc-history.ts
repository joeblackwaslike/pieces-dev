import { homedir } from 'node:os';
import { join } from 'node:path';
import { OS_SERVER_APP, type SourceEvent, urlChangedEvent } from '@pieces-dev/core';
import Database from 'better-sqlite3';
import { roundTo5s } from './round.js';
import type { Source } from './types.js';

const ARC_HISTORY_PATH = join(
	homedir(),
	'Library/Application Support/Arc/User Data/Default/History',
);
const CHROME_EPOCH_OFFSET = 11644473600;

export class ArcHistorySource implements Source {
	readonly name = 'arc';
	private readonly dbPath: string;

	constructor(dbPath?: string) {
		this.dbPath = dbPath ?? ARC_HISTORY_PATH;
	}

	async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
		const fromChrome = (from.getTime() / 1000 + CHROME_EPOCH_OFFSET) * 1_000_000;
		const toChrome = (to.getTime() / 1000 + CHROME_EPOCH_OFFSET) * 1_000_000;

		let db: ReturnType<typeof Database>;
		try {
			db = new Database(this.dbPath, { readonly: true });
		} catch (err) {
			// Default path is macOS; on other platforms (or non-default Arc
			// installs) pass an explicit dbPath. Surface the real error rather
			// than swallowing it.
			console.warn(
				`Arc History DB unavailable at ${this.dbPath} (${(err as Error).message}) — skipping`,
			);
			return;
		}

		try {
			const rows = db
				.prepare(
					`SELECT url, title, last_visit_time
           FROM urls
           WHERE last_visit_time >= ? AND last_visit_time <= ?
           ORDER BY last_visit_time`,
				)
				.all(fromChrome, toChrome) as Array<{
				url: string;
				title: string;
				last_visit_time: number;
			}>;

			for (const row of rows) {
				const unixSeconds = row.last_visit_time / 1_000_000 - CHROME_EPOCH_OFFSET;
				const ts = new Date(unixSeconds * 1000);

				yield {
					timestamp: ts,
					event: urlChangedEvent(OS_SERVER_APP, row.url, row.title || undefined),
					source: 'arc',
					dedupKey: `url_changed:${row.url}:${roundTo5s(ts)}`,
				};
			}
		} finally {
			db.close();
		}
	}
}
