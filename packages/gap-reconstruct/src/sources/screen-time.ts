import { homedir } from 'node:os';
import { join } from 'node:path';
import {
	appEnterEvent,
	appLeaveEvent,
	checkInEvent,
	getAppDisplayName,
	OS_SERVER_APP,
	type SourceEvent,
	VSCODE_APP,
} from '@pieces-dev/core';
import Database from 'better-sqlite3';
import type { Source } from './types.js';

const KNOWLEDGE_DB_PATH = join(homedir(), 'Library/Application Support/Knowledge/knowledgeC.db');
const COREDATA_EPOCH = 978307200;
const CHECK_IN_INTERVAL_S = 60;

const VSCODE_BUNDLE_IDS = new Set(['com.microsoft.VSCodeInsiders', 'com.microsoft.VSCode']);

export class ScreenTimeSource implements Source {
	readonly name = 'screentime';
	private readonly dbPath: string;

	constructor(dbPath?: string) {
		this.dbPath = dbPath ?? KNOWLEDGE_DB_PATH;
	}

	async *collect(from: Date, to: Date): AsyncIterable<SourceEvent> {
		const fromCoreData = from.getTime() / 1000 - COREDATA_EPOCH;
		const toCoreData = to.getTime() / 1000 - COREDATA_EPOCH;

		let db: ReturnType<typeof Database>;
		try {
			db = new Database(this.dbPath, { readonly: true });
		} catch {
			console.warn(`Screen Time DB not found at ${this.dbPath} — skipping`);
			return;
		}

		try {
			const rows = db
				.prepare(
					`SELECT ZSTARTDATE, ZENDDATE, ZVALUESTRING
           FROM ZOBJECT
           WHERE ZSTREAMNAME = '/app/usage'
             AND ZSTARTDATE >= ?
             AND ZSTARTDATE <= ?
           ORDER BY ZSTARTDATE`,
				)
				.all(fromCoreData, toCoreData) as Array<{
				ZSTARTDATE: number;
				ZENDDATE: number;
				ZVALUESTRING: string;
			}>;

			for (const row of rows) {
				const startTs = new Date((row.ZSTARTDATE + COREDATA_EPOCH) * 1000);
				const endTs = new Date((row.ZENDDATE + COREDATA_EPOCH) * 1000);
				const bundleId = row.ZVALUESTRING;
				const displayName = getAppDisplayName(bundleId);
				const isVSCode = VSCODE_BUNDLE_IDS.has(bundleId);
				const app = isVSCode ? VSCODE_APP : OS_SERVER_APP;

				yield {
					timestamp: startTs,
					event: appEnterEvent(app, `${displayName} active`),
					source: 'screentime',
					dedupKey: `application_enter:${bundleId}:${this.roundTo5s(startTs)}`,
				};

				if (isVSCode) {
					let checkInTime = new Date(startTs.getTime() + CHECK_IN_INTERVAL_S * 1000);
					while (checkInTime < endTs) {
						yield {
							timestamp: checkInTime,
							event: checkInEvent(app, `VS Code active`),
							source: 'screentime',
							dedupKey: `check_in:${bundleId}:${this.roundTo5s(checkInTime)}`,
						};
						checkInTime = new Date(checkInTime.getTime() + CHECK_IN_INTERVAL_S * 1000);
					}
				}

				yield {
					timestamp: endTs,
					event: appLeaveEvent(app, `${displayName} backgrounded`),
					source: 'screentime',
					dedupKey: `application_leave:${bundleId}:${this.roundTo5s(endTs)}`,
				};
			}
		} finally {
			db.close();
		}
	}

	private roundTo5s(date: Date): number {
		return Math.round(date.getTime() / 5000) * 5000;
	}
}
