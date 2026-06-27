import { describe, expect, test } from 'vitest';
import { WatchdogEngine } from '../engine.js';
import { makeHarness } from './harness.js';

describe('WatchdogEngine — boot launch', () => {
	test('cleans stale instances, launches, and reports ok when healthy', async () => {
		const h = makeHarness({ settings: { startupGraceSec: 5 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);

		await engine.bootLaunch();

		expect(h.rec.process.filter((c) => c.op === 'killPieces')).toHaveLength(1);
		expect(h.rec.process.some((c) => c.op === 'launchPieces')).toBe(true);
		expect(h.rec.incidents.some((i) => i.kind === 'startup-unhealthy')).toBe(false);
	});

	test('records startup-unhealthy when health never comes up', async () => {
		const h = makeHarness({ settings: { startupGraceSec: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(false);

		await engine.bootLaunch();

		expect(
			h.rec.incidents.some((i) => i.kind === 'startup-unhealthy' && i.severity === 'warn'),
		).toBe(true);
	});

	test('does nothing when manageBootLaunch is off', async () => {
		const h = makeHarness({ settings: { manageBootLaunch: false } });
		const engine = new WatchdogEngine(h.deps);

		await engine.bootLaunch();

		expect(h.rec.process).toEqual([]);
	});
});

describe('WatchdogEngine — restore standby', () => {
	test('onRestoreBegin pauses and acknowledges; onRestoreEnd resumes', async () => {
		const h = makeHarness();
		const engine = new WatchdogEngine(h.deps);

		engine.onRestoreBegin({ restoreId: 'r1' });
		expect(engine.snapshot().paused).toBe(true);
		expect(h.rec.events.some((e) => e.event === 'watchdog.standby-ack')).toBe(true);

		engine.onRestoreEnd();
		expect(engine.snapshot().paused).toBe(false);
	});

	test('healthTick is a no-op while paused', async () => {
		const h = makeHarness({ settings: { healthFailLimit: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(false);
		h.control.setPids([1]);
		h.clock.t = 200_000; // outside grace
		engine.onRestoreBegin({ restoreId: 'r1' });

		await engine.healthTick();
		await engine.pendingEscalation;

		expect(h.rec.incidents).toEqual([]);
		expect(engine.snapshot().restartCount).toBe(0);
	});
});
