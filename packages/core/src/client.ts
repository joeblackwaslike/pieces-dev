const POST_TIMEOUT_MS = 3000;
const SUMMARY_TIMEOUT_MS = 10000;
const HEALTH_TIMEOUT_MS = 2000;

export class PiecesClient {
	private readonly baseUrl: string;

	constructor(port: number) {
		this.baseUrl = `http://localhost:${port}`;
	}

	async postEvent(event: Record<string, unknown>): Promise<string | null> {
		try {
			const res = await fetch(`${this.baseUrl}/workstream_events/create`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(event),
				signal: AbortSignal.timeout(POST_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.warn(`[pieces-dev/core] postEvent failed: ${res.status} ${res.statusText}`);
				return null;
			}
			const data = (await res.json()) as { id?: string };
			return data.id ?? null;
		} catch (err) {
			console.warn('[pieces-dev/core] postEvent error:', err);
			return null;
		}
	}

	async deleteEvent(id: string): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/workstream_events/${id}/delete`, {
				method: 'POST',
				signal: AbortSignal.timeout(POST_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.warn(`[pieces-dev/core] deleteEvent failed: ${res.status} ${res.statusText}`);
			}
			return res.ok;
		} catch (err) {
			console.warn('[pieces-dev/core] deleteEvent error:', err);
			return false;
		}
	}

	async getEvents(): Promise<unknown[]> {
		try {
			const res = await fetch(`${this.baseUrl}/workstream_events`, {
				signal: AbortSignal.timeout(POST_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.warn(`[pieces-dev/core] getEvents failed: ${res.status} ${res.statusText}`);
				return [];
			}
			const data = (await res.json()) as { iterable?: unknown };
			if (!Array.isArray(data.iterable)) {
				console.warn('[pieces-dev/core] getEvents: response.iterable was not an array');
				return [];
			}
			return data.iterable;
		} catch (err) {
			console.warn('[pieces-dev/core] getEvents error:', err);
			return [];
		}
	}

	async triggerSummary(from: Date, to: Date): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/workstream_summaries/create/summary`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// PiecesOS `AnonymousTemporalRange` expects `GroupedTimestamp`
					// objects (`{ value }`), not bare ISO strings.
					anonymous_ranges: [
						{
							from: { value: from.toISOString() },
							to: { value: to.toISOString() },
							between: true,
						},
					],
				}),
				signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.warn(`[pieces-dev/core] triggerSummary failed: ${res.status} ${res.statusText}`);
			}
			return res.ok;
		} catch (err) {
			console.warn('[pieces-dev/core] triggerSummary error:', err);
			return false;
		}
	}

	async checkHealth(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/.well-known/health`, {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			return res.ok;
		} catch {
			// Expected to fail when PiecesOS is offline; callers poll this, so
			// logging here would be noise.
			return false;
		}
	}
}
