import { describe, expect, test } from 'vitest';
import type { WatchdogSnapshot } from '../engine.js';
import { buildMenuSection } from '../menu.js';

const base: WatchdogSnapshot = {
	restartCount: 0,
	healthFailStreak: 0,
	authLoggedIn: true,
	lastCleanTime: 0,
	escalating: false,
	gaveUp: false,
	paused: false,
};

describe('watchdog menu', () => {
	test('titled "Pieces OS" with run-command actions for the verbs', () => {
		const section = buildMenuSection(base);
		expect(section.title).toBe('Pieces OS');
		const commandIds = section.items
			.map((i) => i.action)
			.filter((a): a is { type: 'run-command'; commandId: string } => a?.type === 'run-command')
			.map((a) => a.commandId);
		expect(commandIds).toContain('watchdog.restart');
		expect(commandIds).toContain('watchdog.kill-duplicates');
		expect(commandIds).toContain('watchdog.check-auth');
	});

	test('shows the logged-out state', () => {
		const section = buildMenuSection({ ...base, authLoggedIn: false });
		expect(section.items.some((i) => /logged out/i.test(i.label))).toBe(true);
	});

	test('offers a reset item only when gave up', () => {
		const normal = buildMenuSection(base);
		const gaveUp = buildMenuSection({ ...base, gaveUp: true });
		const hasReset = (s: ReturnType<typeof buildMenuSection>) =>
			s.items.some(
				(i) => i.action?.type === 'run-command' && i.action.commandId === 'watchdog.reset',
			);
		expect(hasReset(normal)).toBe(false);
		expect(hasReset(gaveUp)).toBe(true);
	});
});
