import { PiecesClient, discoverPort } from '@pieces-dev/core';
import type { PiecesApi } from '@pieces-dev/monitor-sdk';

/** Shared Pieces OS discovery/health, wrapping `@pieces-dev/core`. */
export class Pieces {
	private port: number | null = null;

	async discoverPort(): Promise<number | null> {
		this.port = await discoverPort();
		return this.port;
	}

	baseUrl(): string | null {
		return this.port !== null ? `http://127.0.0.1:${this.port}` : null;
	}

	async checkHealth(): Promise<boolean> {
		const port = this.port ?? (await this.discoverPort());
		if (port === null) return false;
		return new PiecesClient(port).checkHealth();
	}

	api(): PiecesApi {
		return {
			discoverPort: () => this.discoverPort(),
			checkHealth: () => this.checkHealth(),
			baseUrl: () => this.baseUrl(),
		};
	}
}
