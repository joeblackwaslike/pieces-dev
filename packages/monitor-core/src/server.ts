import websocket from '@fastify/websocket';
import type { ApiHandler } from '@pieces-dev/monitor-sdk';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Services } from './runtime.js';
import { renderShell } from './shell.js';

export interface ServerOptions {
	/** Bearer token required for state-changing endpoints. */
	token: string;
}

/** Build the daemon's HTTP/WS server. Loopback-only; bound by the caller. */
export function buildServer(services: Services, options: ServerOptions): FastifyInstance {
	const app = Fastify();

	const authorized = (req: FastifyRequest): boolean =>
		req.headers.authorization === `Bearer ${options.token}`;

	const limitOf = (req: FastifyRequest): number => {
		const raw = (req.query as Record<string, string | undefined>).limit;
		const n = raw ? Number(raw) : 100;
		return Number.isFinite(n) ? n : 100;
	};

	app.get('/status', () => services.health.overall());

	app.get('/menu', () => services.menu.build(services.health.overall().state));

	app.get('/incidents', (req) =>
		services.incidents.forExtension('core').query({ limit: limitOf(req) }),
	);

	app.get('/logs', (req) => services.log.forExtension('core').query({ limit: limitOf(req) }));

	app.post('/actions/:id', async (req, reply) => {
		if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' });
		const { id } = req.params as { id: string };
		try {
			const result = await services.commands.dispatch(
				id,
				(req.body ?? {}) as Record<string, unknown>,
			);
			return { result };
		} catch (error) {
			return reply.code(404).send({ error: (error as Error).message });
		}
	});

	app.get('/', async (_req, reply) => {
		reply.header('content-type', 'text/html; charset=utf-8');
		return renderShell(services);
	});

	// Mount extension-registered endpoints under /api/ext/<id>.
	for (const route of services.api.routes) {
		const handler = adapt(route.handler);
		if (route.method === 'GET') app.get(route.path, handler);
		else app.post(route.path, handler);
	}

	// Live event push over WebSocket, fed by the event bus.
	app.register(websocket);
	app.register(async (instance) => {
		instance.get('/events', { websocket: true }, (socket) => {
			const off = services.bus.onAny((event, payload) => {
				socket.send(JSON.stringify({ event, payload }));
			});
			socket.on('close', off);
		});
	});

	return app;
}

function adapt(handler: ApiHandler) {
	return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
		const result = await handler({
			params: req.params as Record<string, string>,
			query: req.query as Record<string, string | string[] | undefined>,
			body: req.body,
			headers: req.headers as Record<string, string | undefined>,
		});
		if (result.status) reply.code(result.status);
		if (result.headers) for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
		if (result.json !== undefined) return result.json;
		return result.body ?? '';
	};
}
