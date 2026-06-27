import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Incident, LogEntry, OverallStatus } from '@pieces-dev/monitor-sdk';

const DEFAULT_BASE = 'http://127.0.0.1:4747';

/** Thin HTTP client for the daemon's loopback API. */
export class MonitorClient {
	constructor(
		private readonly baseUrl: string = DEFAULT_BASE,
		private readonly token?: string,
	) {}

	private async getJson<T>(path: string): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`);
		if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
		return (await res.json()) as T;
	}

	status(): Promise<OverallStatus> {
		return this.getJson<OverallStatus>('/status');
	}

	incidents(limit = 50): Promise<Incident[]> {
		return this.getJson<Incident[]>(`/incidents?limit=${limit}`);
	}

	logs(limit = 50): Promise<LogEntry[]> {
		return this.getJson<LogEntry[]>(`/logs?limit=${limit}`);
	}

	async dispatch(id: string, params?: Record<string, unknown>): Promise<unknown> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		const res = await fetch(`${this.baseUrl}/actions/${id}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(params ?? {}),
		});
		if (!res.ok) throw new Error(`action ${id} → ${res.status}`);
		return ((await res.json()) as { result: unknown }).result;
	}

	async isUp(): Promise<boolean> {
		try {
			await this.status();
			return true;
		} catch {
			return false;
		}
	}
}

/** Read the daemon's loopback bearer token, if present. */
export function readToken(): string | undefined {
	try {
		return readFileSync(
			join(homedir(), 'Library/Application Support/PiecesMonitor/token'),
			'utf8',
		).trim();
	} catch {
		return undefined;
	}
}
