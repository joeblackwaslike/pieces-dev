import { describe, expect, test } from 'vitest';
import { WatchdogEngine } from '../engine.js';
import { makeHarness } from './harness.js';

describe('WatchdogEngine — auth tick', () => {
	test('true→false: records auth-lost, notifies, opens the app, emits, reports warn', async () => {
		const h = makeHarness({ persisted: { authLoggedIn: true } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setUser({ status: 200, body: '{}' }); // no id/email → logged out

		await engine.authTick();

		expect(h.rec.incidents.some((i) => i.kind === 'auth-lost' && i.severity === 'warn')).toBe(true);
		expect(h.rec.notifies).toHaveLength(1);
		expect(h.rec.process.some((c) => c.op === 'openApp')).toBe(true);
		expect(h.rec.events.some((e) => e.event === 'watchdog.auth-lost')).toBe(true);
		expect(h.rec.health.at(-1)).toMatchObject({ checkId: 'pieces-auth', state: 'warn' });
		expect(engine.snapshot().authLoggedIn).toBe(false);
	});

	test('false→true: records auth-restored, notifies, emits, reports ok', async () => {
		const h = makeHarness({ persisted: { authLoggedIn: false } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setUser({ status: 200, body: JSON.stringify({ id: 'u1' }) });

		await engine.authTick();

		expect(h.rec.incidents.some((i) => i.kind === 'auth-restored')).toBe(true);
		expect(h.rec.events.some((e) => e.event === 'watchdog.auth-restored')).toBe(true);
		expect(h.rec.health.at(-1)).toMatchObject({ checkId: 'pieces-auth', state: 'ok' });
		expect(engine.snapshot().authLoggedIn).toBe(true);
	});

	test('still logged out (false→false) is quiet but still warns', async () => {
		const h = makeHarness({ persisted: { authLoggedIn: false } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setUser({ status: 200, body: '{}' });

		await engine.authTick();

		expect(h.rec.notifies).toEqual([]);
		expect(h.rec.incidents).toEqual([]);
		expect(h.rec.health.at(-1)).toMatchObject({ checkId: 'pieces-auth', state: 'warn' });
	});

	test('parses nested {user:{email}} shape as logged in', async () => {
		const h = makeHarness({ persisted: { authLoggedIn: false } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setUser({ status: 200, body: JSON.stringify({ user: { email: 'a@b.c' } }) });

		await engine.authTick();

		expect(engine.snapshot().authLoggedIn).toBe(true);
	});

	test('non-200 is treated as logged out', async () => {
		const h = makeHarness({ persisted: { authLoggedIn: true } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setUser({ status: 401, body: '' });

		await engine.authTick();

		expect(engine.snapshot().authLoggedIn).toBe(false);
		expect(h.rec.health.at(-1)).toMatchObject({ checkId: 'pieces-auth', state: 'warn' });
	});

	test('never reports pieces-auth as crit', async () => {
		const h = makeHarness({ persisted: { authLoggedIn: true } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setUser({ status: 500, body: '' });

		await engine.authTick();

		expect(h.rec.health.every((r) => r.checkId !== 'pieces-auth' || r.state !== 'crit')).toBe(true);
	});
});
