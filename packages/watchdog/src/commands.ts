import type { Command } from '@pieces-dev/monitor-sdk';
import type { WatchdogEngine } from './engine.js';

/** The watchdog's command verbs — invokable from menu bar, dashboard, CLI, and API. */
export function buildCommands(engine: WatchdogEngine): Command[] {
	return [
		{
			id: 'watchdog.restart',
			title: 'Restart Pieces OS',
			destructive: true,
			async: true,
			expectedDurationMs: 90_000,
			handler: async () => {
				await engine.escalate();
				return engine.snapshot();
			},
		},
		{
			id: 'watchdog.kill-duplicates',
			title: 'Kill Duplicate Instances',
			destructive: true,
			handler: async () => ({ instances: await engine.killDuplicates() }),
		},
		{
			id: 'watchdog.relaunch',
			title: 'Relaunch Pieces OS',
			destructive: true,
			async: true,
			expectedDurationMs: 30_000,
			handler: async () => {
				await engine.relaunch();
				return engine.snapshot();
			},
		},
		{
			id: 'watchdog.check-auth',
			title: 'Check Pieces Login',
			handler: async () => {
				await engine.authTick();
				return engine.snapshot();
			},
		},
		{
			id: 'watchdog.reset',
			title: 'Reset Watchdog (clear restart budget)',
			handler: () => {
				engine.reset();
				return engine.snapshot();
			},
		},
		{
			id: 'watchdog.status',
			title: 'Watchdog Status',
			handler: () => engine.snapshot(),
		},
	];
}
