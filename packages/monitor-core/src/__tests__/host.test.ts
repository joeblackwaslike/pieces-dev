import { describe, expect, test } from 'vitest';
import type { Extension } from '@pieces-dev/monitor-sdk';
import { Host } from '../host.js';
import { buildServices } from '../runtime.js';

describe('Host', () => {
	test('loading an extension wires its contributions into the services', async () => {
		const services = buildServices({ dbPath: ':memory:' });
		const host = new Host(services);

		const ext: Extension = {
			id: 'demo',
			name: 'Demo',
			version: '0.0.0',
			activate(ctx) {
				ctx.health.report('demo.alive', 'warn', 'just a demo');
				ctx.commands.register({ id: 'demo.ping', title: 'Ping', handler: () => 'pong' });
				ctx.menu.contribute(() => ({
					title: 'Demo',
					items: [{ label: 'Ping', action: { type: 'run-command', commandId: 'demo.ping' } }],
				}));
				ctx.incidents.record({ kind: 'started', severity: 'info', summary: 'demo started' });
				ctx.api.get('/hello', () => ({ json: { ok: true } }));
			},
		};

		await host.load(ext);

		expect(services.health.overall().state).toBe('warn');
		await expect(services.commands.dispatch('demo.ping')).resolves.toBe('pong');

		const menu = services.menu.build(services.health.overall().state);
		expect(menu.status).toBe('warn');
		expect(menu.sections.some((s) => s.title === 'Demo')).toBe(true);

		expect(services.incidents.forExtension('demo').query({ kind: 'started' })).toHaveLength(1);
		expect(services.api.routes.map((r) => r.path)).toContain('/api/ext/demo/hello');
	});
});
