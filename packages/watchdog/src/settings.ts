import type { ConfigApi, SettingsSchema } from '@pieces-dev/monitor-sdk';

/**
 * The watchdog's tunables, ported one-for-one from the Python babysitter
 * constants. All are live-reloadable: the engine reads a fresh snapshot via
 * {@link readSettings} on every tick.
 */
export interface WatchdogSettings {
	/** Seconds between health checks. */
	healthIntervalSec: number;
	/** Seconds between auth (`/user`) checks. */
	authCheckIntervalSec: number;
	/** Consecutive health failures before an escalated restart. */
	healthFailLimit: number;
	/** Seconds to wait after a Tier-1 API restart before re-checking. */
	restartWaitSec: number;
	/** Restart budget — give up once this many restarts is exceeded. */
	maxRestarts: number;
	/** Seconds of clean uptime that resets the restart counter. */
	cleanUptimeResetSec: number;
	/** Seconds after launch during which health failures don't trigger restarts. */
	startupGraceSec: number;
	/** Whether the watchdog launches Pieces OS at boot (Pieces' own launcher is neutralized). */
	manageBootLaunch: boolean;
	/** Seconds after GAVE_UP before a single auto-rearm; `0` disables auto-rearm. */
	gaveUpCooloffSec: number;
	/** Seconds to wait for health after a per-tier (re)launch. */
	startupWaitTimeoutSec: number;
}

export const WATCHDOG_DEFAULTS: WatchdogSettings = {
	healthIntervalSec: 10,
	authCheckIntervalSec: 300,
	healthFailLimit: 3,
	restartWaitSec: 30,
	maxRestarts: 5,
	cleanUptimeResetSec: 600,
	startupGraceSec: 90,
	manageBootLaunch: true,
	gaveUpCooloffSec: 1800,
	startupWaitTimeoutSec: 60,
};

export const WATCHDOG_SCHEMA: SettingsSchema = {
	sections: [
		{
			id: 'health',
			title: 'Health & Restart',
			fields: [
				{
					key: 'healthIntervalSec',
					label: 'Health check interval (s)',
					help: 'Seconds between Pieces OS health checks.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.healthIntervalSec,
					min: 5,
				},
				{
					key: 'healthFailLimit',
					label: 'Failures before restart',
					help: 'Consecutive failed health checks before an escalated restart.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.healthFailLimit,
					min: 1,
				},
				{
					key: 'restartWaitSec',
					label: 'API restart wait (s)',
					help: 'Seconds to wait after a graceful API restart before re-checking health.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.restartWaitSec,
					min: 5,
				},
				{
					key: 'maxRestarts',
					label: 'Max restarts',
					help: 'Restart budget before the watchdog gives up and alerts.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.maxRestarts,
					min: 1,
				},
				{
					key: 'cleanUptimeResetSec',
					label: 'Clean-uptime reset (s)',
					help: 'Seconds of healthy uptime that resets the restart counter.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.cleanUptimeResetSec,
					min: 60,
				},
				{
					key: 'gaveUpCooloffSec',
					label: 'Give-up cooloff (s)',
					help: 'Seconds after giving up before a single automatic re-arm. 0 disables it.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.gaveUpCooloffSec,
					min: 0,
				},
			],
		},
		{
			id: 'auth-boot',
			title: 'Auth & Boot',
			fields: [
				{
					key: 'authCheckIntervalSec',
					label: 'Auth check interval (s)',
					help: 'Seconds between Pieces login checks.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.authCheckIntervalSec,
					min: 30,
				},
				{
					key: 'startupGraceSec',
					label: 'Startup grace (s)',
					help: 'Seconds after launch during which health failures do not trigger restarts.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.startupGraceSec,
					min: 0,
				},
				{
					key: 'startupWaitTimeoutSec',
					label: 'Relaunch startup wait (s)',
					help: 'Seconds to wait for health after a relaunch.',
					type: 'number',
					default: WATCHDOG_DEFAULTS.startupWaitTimeoutSec,
					min: 10,
				},
				{
					key: 'manageBootLaunch',
					label: 'Launch Pieces OS at boot',
					help: 'The watchdog owns the boot launch (Pieces OS’ own launcher is neutralized).',
					type: 'bool',
					default: WATCHDOG_DEFAULTS.manageBootLaunch,
				},
			],
		},
	],
};

/** Read a fresh, fully-populated settings snapshot, falling back to defaults per key. */
export function readSettings(config: ConfigApi): WatchdogSettings {
	const num = (key: keyof WatchdogSettings, fallback: number): number => {
		const value = config.get<number>(key);
		return typeof value === 'number' ? value : fallback;
	};
	const bool = (key: keyof WatchdogSettings, fallback: boolean): boolean => {
		const value = config.get<boolean>(key);
		return typeof value === 'boolean' ? value : fallback;
	};
	return {
		healthIntervalSec: num('healthIntervalSec', WATCHDOG_DEFAULTS.healthIntervalSec),
		authCheckIntervalSec: num('authCheckIntervalSec', WATCHDOG_DEFAULTS.authCheckIntervalSec),
		healthFailLimit: num('healthFailLimit', WATCHDOG_DEFAULTS.healthFailLimit),
		restartWaitSec: num('restartWaitSec', WATCHDOG_DEFAULTS.restartWaitSec),
		maxRestarts: num('maxRestarts', WATCHDOG_DEFAULTS.maxRestarts),
		cleanUptimeResetSec: num('cleanUptimeResetSec', WATCHDOG_DEFAULTS.cleanUptimeResetSec),
		startupGraceSec: num('startupGraceSec', WATCHDOG_DEFAULTS.startupGraceSec),
		manageBootLaunch: bool('manageBootLaunch', WATCHDOG_DEFAULTS.manageBootLaunch),
		gaveUpCooloffSec: num('gaveUpCooloffSec', WATCHDOG_DEFAULTS.gaveUpCooloffSec),
		startupWaitTimeoutSec: num('startupWaitTimeoutSec', WATCHDOG_DEFAULTS.startupWaitTimeoutSec),
	};
}
