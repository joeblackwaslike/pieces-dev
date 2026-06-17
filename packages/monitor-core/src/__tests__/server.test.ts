import { afterEach, describe, expect, test } from 'vitest';
import { buildServices } from '../runtime.js';
import { buildServer } from '../server.js';

function setup() {
	const services = buildServices({ dbPath: ':memory:' });
	services.commands.api().register({ id: 'ping', title: 'Ping', handler: () => 'pong' });
	services.health.forExtension('core').report('core.hello', 'ok');
	services.incidents
		.forExtension('core')
		.record({ kind: 'boot', severity: 'info', summary: 'started' });
	const app = buildServer(services, { token: 'secret' });
	return { app, services };
}

describe('Daemon server', () => {
	let close: (() => Promise<void>) | undefined;
	afterEach(async () => {
		await close?.();
		close = undefined;
	});

	test('GET /status returns the health rollup', async () => {
		const { app } = setup();
		close = () => app.close();
		const res = await app.inject({ method: 'GET', url: '/status' });
		expect(res.statusCode).toBe(200);
		expect(res.json().state).toBe('ok');
	});

	test('GET /menu returns the menu model', async () => {
		const { app } = setup();
		close = () => app.close();
		const res = await app.inject({ method: 'GET', url: '/menu' });
		expect(res.statusCode).toBe(200);
		expect(res.json().status).toBe('ok');
	});

	test('GET /incidents returns recorded incidents', async () => {
		const { app } = setup();
		close = () => app.close();
		const res = await app.inject({ method: 'GET', url: '/incidents' });
		expect(res.json()).toHaveLength(1);
		expect(res.json()[0].kind).toBe('boot');
	});

	test('POST /actions/:id requires the bearer token', async () => {
		const { app } = setup();
		close = () => app.close();
		const unauth = await app.inject({ method: 'POST', url: '/actions/ping' });
		expect(unauth.statusCode).toBe(401);
		const ok = await app.inject({
			method: 'POST',
			url: '/actions/ping',
			headers: { authorization: 'Bearer secret' },
		});
		expect(ok.statusCode).toBe(200);
		expect(ok.json().result).toBe('pong');
	});

	test('GET / serves the SSR dashboard shell', async () => {
		const { app } = setup();
		close = () => app.close();
		const res = await app.inject({ method: 'GET', url: '/' });
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toContain('Pieces Monitor');
	});
});
