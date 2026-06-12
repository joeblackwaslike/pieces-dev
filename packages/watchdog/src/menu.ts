import type { MenuItem, MenuSection } from '@pieces-dev/monitor-sdk';
import type { WatchdogSnapshot } from './engine.js';

/** Build the menu-bar "Pieces OS" section from a watchdog snapshot. */
export function buildMenuSection(snapshot: WatchdogSnapshot): MenuSection {
	const items: MenuItem[] = [
		{
			label: snapshot.gaveUp
				? `Restarts: ${snapshot.restartCount} (gave up)`
				: `Restarts: ${snapshot.restartCount}`,
			enabled: false,
		},
		{ label: snapshot.authLoggedIn ? 'Logged in' : 'Logged out', enabled: false },
		{
			label: 'Restart Pieces OS',
			action: { type: 'run-command', commandId: 'watchdog.restart' },
		},
		{
			label: 'Kill Duplicate Instances',
			action: { type: 'run-command', commandId: 'watchdog.kill-duplicates' },
		},
		{
			label: 'Re-check Login',
			action: { type: 'run-command', commandId: 'watchdog.check-auth' },
		},
	];

	if (snapshot.gaveUp) {
		items.push({
			label: 'Reset Watchdog',
			action: { type: 'run-command', commandId: 'watchdog.reset' },
		});
	}

	return { title: 'Pieces OS', items };
}
