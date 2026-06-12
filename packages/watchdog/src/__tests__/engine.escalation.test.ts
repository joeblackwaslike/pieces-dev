import { describe, expect, test } from 'vitest';
import { WatchdogEngine } from '../engine.js';
import { makeHarness } from './harness.js';

describe('WatchdogEngine — escalation', () => {
	test('Tier 1 (API restart) success: no kill, records success, emits watchdog.restarted', async () => {
		const h = makeHarness({ settings: { restartWaitSec: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true); // health recovers after the API restart

		await engine.escalate();

		expect(h.rec.process.some((c) => c.op === 'killPieces')).toBe(false);
		expect(h.rec.incidents.some((i) => i.kind === 'restart-attempt')).toBe(true);
		expect(h.rec.incidents.some((i) => i.kind === 'restart-succeeded')).toBe(true);
		expect(h.rec.events.some((e) => e.event === 'watchdog.restarted')).toBe(true);
		expect(engine.snapshot().restartCount).toBe(1);
	});

	test('Tier 2 (SIGTERM) success after Tier 1 fails', async () => {
		const h = makeHarness({ settings: { restartWaitSec: 1, startupWaitTimeoutSec: 5 } });
		const engine = new WatchdogEngine(h.deps);
		let calls = 0;
		h.control.setHealthy(() => ++calls >= 2); // tier1 check fails, tier2 wait succeeds

		await engine.escalate();

		const kills = h.rec.process.filter((c) => c.op === 'killPieces');
		expect(kills.some((c) => c.arg === 'term')).toBe(true);
		expect(kills.some((c) => c.arg === 'kill')).toBe(false);
		expect(h.rec.incidents.some((i) => i.kind === 'restart-succeeded')).toBe(true);
	});

	test('all tiers fail: no success, restart attempt still counted', async () => {
		const h = makeHarness({ settings: { restartWaitSec: 1, startupWaitTimeoutSec: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(false);

		await engine.escalate();

		expect(h.rec.process.filter((c) => c.op === 'killPieces').some((c) => c.arg === 'kill')).toBe(true);
		expect(h.rec.incidents.some((i) => i.kind === 'restart-succeeded')).toBe(false);
		expect(engine.snapshot().restartCount).toBe(1);
	});

	test('reentrancy: a concurrent escalate() is a no-op', async () => {
		const h = makeHarness({ settings: { restartWaitSec: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);

		const p1 = engine.escalate();
		const p2 = engine.escalate(); // guard should reject this one
		await Promise.all([p1, p2]);

		expect(engine.snapshot().restartCount).toBe(1);
		expect(h.rec.events.filter((e) => e.event === 'watchdog.restarting')).toHaveLength(1);
	});

	test('latches GAVE_UP when the restart budget is exceeded', async () => {
		const h = makeHarness({ settings: { maxRestarts: 1, gaveUpCooloffSec: 1800 }, persisted: { restartCount: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);

		await engine.escalate(); // restartCount 1 -> 2, exceeds max of 1

		expect(engine.snapshot().gaveUp).toBe(true);
		expect(h.rec.notifies.some((n) => n.severity === 'crit')).toBe(true);
		expect(h.rec.health.some((r) => r.checkId === 'pieces-os' && r.state === 'crit')).toBe(true);
		expect(h.rec.incidents.some((i) => i.kind === 'gave-up')).toBe(true);
		expect(h.rec.events.some((e) => e.event === 'watchdog.gave-up')).toBe(true);
		expect(h.rec.rearms).toHaveLength(1);
		expect(h.rec.rearms[0]?.delayMs).toBe(1800 * 1000);
	});

	test('no auto-rearm scheduled when cooloff is 0', async () => {
		const h = makeHarness({ settings: { maxRestarts: 1, gaveUpCooloffSec: 0 }, persisted: { restartCount: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);

		await engine.escalate();

		expect(engine.snapshot().gaveUp).toBe(true);
		expect(h.rec.rearms).toHaveLength(0);
	});

	test('firing the auto-rearm resets the budget and un-latches', async () => {
		const h = makeHarness({ settings: { maxRestarts: 1, gaveUpCooloffSec: 1800 }, persisted: { restartCount: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);
		await engine.escalate();

		h.rec.rearms[0]?.fn(); // simulate the cooloff elapsing

		expect(engine.snapshot().gaveUp).toBe(false);
		expect(engine.snapshot().restartCount).toBe(0);
	});

	test('reset() clears the budget, un-latches, and cancels a pending rearm', async () => {
		const h = makeHarness({ settings: { maxRestarts: 1, gaveUpCooloffSec: 1800 }, persisted: { restartCount: 1 } });
		const engine = new WatchdogEngine(h.deps);
		h.control.setHealthy(true);
		await engine.escalate();

		engine.reset();

		expect(engine.snapshot().gaveUp).toBe(false);
		expect(engine.snapshot().restartCount).toBe(0);
		expect(h.rec.rearms[0]?.cancelled).toBe(true);
	});
});
