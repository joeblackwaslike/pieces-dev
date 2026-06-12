import { describe, expect, test } from 'vitest';
import { WatchdogEngine } from '../engine.js';
import { makeHarness } from './harness.js';

const GRACE_MS = 90_000;

describe('WatchdogEngine — health tick', () => {
	test('lazily resets the restart counter after clean uptime', async () => {
		const h = makeHarness({ persisted: { restartCount: 2, lastCleanTime: 0 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);
		h.clock.t = 700_000; // > cleanUptimeResetSec (600s) since lastCleanTime=0

		await engine.healthTick();

		expect(engine.snapshot().restartCount).toBe(0);
		expect(h.rec.saves).toContainEqual({ restartCount: 0 });
	});

	test('does not reset the counter within the clean-uptime window', async () => {
		const h = makeHarness({ persisted: { restartCount: 2, lastCleanTime: 695_000 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);
		h.clock.t = 700_000; // only 5s since lastCleanTime

		await engine.healthTick();

		expect(engine.snapshot().restartCount).toBe(2);
	});

	test('reports ok and clears the streak when healthy', async () => {
		const h = makeHarness();
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);
		h.clock.t = GRACE_MS + 1;

		await engine.healthTick();

		expect(h.rec.health.at(-1)).toMatchObject({ checkId: 'pieces-os', state: 'ok' });
	});

	test('suppresses restarts during the startup grace window', async () => {
		const h = makeHarness({ settings: { healthFailLimit: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(false);
		h.clock.t = GRACE_MS - 1; // still within grace

		await engine.healthTick();
		await engine.pendingEscalation;

		expect(h.rec.incidents).toEqual([]);
		expect(engine.snapshot().restartCount).toBe(0);
		expect(h.rec.health.at(-1)).toMatchObject({ checkId: 'pieces-os', state: 'warn' });
	});

	test('warns under the fail limit without escalating', async () => {
		const h = makeHarness({ settings: { healthFailLimit: 3 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(false);
		h.clock.t = GRACE_MS + 1;

		await engine.healthTick();
		await engine.pendingEscalation;

		expect(engine.snapshot().healthFailStreak).toBe(1);
		expect(h.rec.incidents).toEqual([]);
	});

	test('records pieces-health-fail and dispatches escalation at the fail limit', async () => {
		const h = makeHarness({ settings: { healthFailLimit: 1, startupWaitTimeoutSec: 1, restartWaitSec: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(false);
		h.clock.t = GRACE_MS + 1;

		await engine.healthTick();
		await engine.pendingEscalation;

		expect(h.rec.incidents.some((i) => i.kind === 'pieces-health-fail')).toBe(true);
		expect(engine.snapshot().restartCount).toBe(1); // escalation incremented the attempt
	});

	test('kills duplicate instances and records a crit incident', async () => {
		const h = makeHarness();
		const engine = new WatchdogEngine(h.deps);
		h.control.setPids([10, 11]);
		h.clock.t = GRACE_MS + 1;

		await engine.healthTick();

		expect(h.rec.incidents.some((i) => i.kind === 'duplicate-instance' && i.severity === 'crit')).toBe(true);
		expect(h.rec.process.some((c) => c.op === 'killPieces')).toBe(true);
		expect(h.rec.process.some((c) => c.op === 'launchPieces')).toBe(true);
		expect(h.rec.events.some((e) => e.event === 'watchdog.duplicate-killed')).toBe(true);
	});

	test('relaunches a missing instance outside grace', async () => {
		const h = makeHarness();
		const engine = new WatchdogEngine(h.deps);
		h.control.setPids([]);
		h.clock.t = GRACE_MS + 1;

		await engine.healthTick();

		expect(h.rec.incidents.some((i) => i.kind === 'process-missing')).toBe(true);
		expect(h.rec.process.some((c) => c.op === 'launchPieces')).toBe(true);
	});

	test('does not relaunch a missing instance during grace', async () => {
		const h = makeHarness();
		const engine = new WatchdogEngine(h.deps);
		h.control.setPids([]);
		h.clock.t = GRACE_MS - 1;

		await engine.healthTick();

		expect(h.rec.incidents).toEqual([]);
		expect(h.rec.process.some((c) => c.op === 'launchPieces')).toBe(false);
	});
});
