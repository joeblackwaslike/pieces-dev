const POST_TIMEOUT_MS = 3000;

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
      if (!res.ok) return null;
      const data = (await res.json()) as { id?: string };
      return data.id ?? null;
    } catch {
      return null;
    }
  }

  async deleteEvent(id: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/workstream_events/${id}/delete`, {
        method: 'POST',
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getEvents(): Promise<unknown[]> {
    try {
      const res = await fetch(`${this.baseUrl}/workstream_events`, {
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { iterable?: unknown[] };
      return data.iterable ?? [];
    } catch {
      return [];
    }
  }

  async triggerSummary(from: Date, to: Date): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/workstream_summaries/create/summary`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            anonymous_ranges: [
              {
                from: from.toISOString(),
                to: to.toISOString(),
                between: true,
              },
            ],
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/.well-known/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
