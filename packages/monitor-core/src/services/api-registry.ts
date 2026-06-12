import type { ApiApi, ApiHandler, WsHandler } from '@pieces-dev/monitor-sdk';

export interface Route {
	method: 'GET' | 'POST';
	path: string;
	handler: ApiHandler;
}

export interface WsRoute {
	path: string;
	handler: WsHandler;
}

/**
 * Collects the namespaced HTTP/WS endpoints extensions register. The server
 * mounts everything in {@link routes} / {@link wsRoutes} under `/api/ext/<id>`.
 */
export class ApiRegistry {
	readonly routes: Route[] = [];
	readonly wsRoutes: WsRoute[] = [];

	forExtension(id: string): ApiApi {
		const base = `/api/ext/${id}`;
		return {
			get: (path, handler) => this.routes.push({ method: 'GET', path: base + path, handler }),
			post: (path, handler) => this.routes.push({ method: 'POST', path: base + path, handler }),
			ws: (path, handler) => this.wsRoutes.push({ path: base + path, handler }),
		};
	}
}
