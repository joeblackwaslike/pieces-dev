import { describe, expect, test } from 'vitest';
import { buildCommands } from '../commands.js';
import { WatchdogEngine } from '../engine.js';
import { makeHarness } from './harness.js';

function commandsFor(h = makeHarness()) {
	const engine = new WatchdogEngine(h.deps);
	const byId = new Map(buildCommands(engine).map((c) => [c.id, c]));
	return { h, engine, byId };
}

describe('watchdog commands', () => {
	test('registers all six watchdog verbs', () => {
		const { byId } = commandsFor();
		for (const id of [
			'watchdog.restart',
			'watchdog.kill-duplicates',
			'watchdog.relaunch',
			'watchdog.check-auth',
			'watchdog.reset',
			'watchdog.status',
		]) {
			expect(byId.has(id), `missing ${id}`).toBe(true);
		}
	});

	test('destructive verbs are flagged destructive', () => {
		const { byId } = commandsFor();
		expect(byId.get('watchdog.restart')?.destructive).toBe(true);
		expect(byId.get('watchdog.kill-duplicates')?.destructive).toBe(true);
		expect(byId.get('watchdog.relaunch')?.destructive).toBe(true);
		expect(byId.get('watchdog.status')?.destructive).toBeFalsy();
	});

	test('watchdog.status returns the engine snapshot', async () => {
		const { byId } = commandsFor(makeHarness({ persisted: { restartCount: 4 } }));
		const result = (await byId.get('watchdog.status')?.handler()) as { restartCount: number };
		expect(result.restartCount).toBe(4);
	});

	test('watchdog.reset clears the restart budget', async () => {
		const { engine, byId } = commandsFor(makeHarness({ persisted: { restartCount: 3 } }));
		await byId.get('watchdog.reset')?.handler();
		expect(engine.snapshot().restartCount).toBe(0);
	});

	test('watchdog.kill-duplicates runs the duplicate killer', async () => {
		const { h, byId } = commandsFor();
		h.control.setPids([10, 11]);
		await byId.get('watchdog.kill-duplicates')?.handler();
		expect(h.rec.process.some((c) => c.op === 'killPieces')).toBe(true);
		expect(h.rec.events.some((e) => e.event === 'watchdog.duplicate-killed')).toBe(true);
	});

	test('watchdog.relaunch kills and relaunches', async () => {
		const { h, byId } = commandsFor();
		await byId.get('watchdog.relaunch')?.handler();
		expect(h.rec.process.some((c) => c.op === 'killPieces')).toBe(true);
		expect(h.rec.process.some((c) => c.op === 'launchPieces')).toBe(true);
	});

	test('watchdog.check-auth runs an auth tick', async () => {
		const { h, byId } = commandsFor(makeHarness({ persisted: { authLoggedIn: true } }));
		h.control.setUser({ status: 401, body: '' });
		await byId.get('watchdog.check-auth')?.handler();
		expect(h.rec.health.some((r) => r.checkId === 'pieces-auth')).toBe(true);
	});
});
