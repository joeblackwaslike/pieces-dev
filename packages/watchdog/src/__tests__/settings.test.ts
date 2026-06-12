import type { ConfigApi } from '@pieces-dev/monitor-sdk';
import { describe, expect, test } from 'vitest';
import { WATCHDOG_DEFAULTS, WATCHDOG_SCHEMA, readSettings } from '../settings.js';

/** Minimal ConfigApi backed by a plain map (no schema-default resolution). */
function fakeConfig(values: Record<string, unknown> = {}): ConfigApi {
	const store = new Map(Object.entries(values));
	return {
		registerSchema: () => {},
		get: <T = unknown>(key: string) => store.get(key) as T | undefined,
		set: (key, value) => {
			store.set(key, value);
		},
		all: () => Object.fromEntries(store),
		onChange: () => () => {},
	};
}

describe('watchdog settings', () => {
	test('readSettings falls back to the ported defaults when config is empty', () => {
		const s = readSettings(fakeConfig());
		expect(s).toEqual(WATCHDOG_DEFAULTS);
		expect(s.healthIntervalSec).toBe(10);
		expect(s.authCheckIntervalSec).toBe(300);
		expect(s.healthFailLimit).toBe(3);
		expect(s.maxRestarts).toBe(5);
		expect(s.startupGraceSec).toBe(90);
		expect(s.manageBootLaunch).toBe(true);
		expect(s.gaveUpCooloffSec).toBe(1800);
	});

	test('readSettings reflects overrides from config', () => {
		const s = readSettings(fakeConfig({ healthIntervalSec: 5, manageBootLaunch: false }));
		expect(s.healthIntervalSec).toBe(5);
		expect(s.manageBootLaunch).toBe(false);
		// untouched keys keep their defaults
		expect(s.maxRestarts).toBe(5);
	});

	test('the schema exposes a field for every default with a matching default value', () => {
		const fields = WATCHDOG_SCHEMA.sections.flatMap((sec) => sec.fields);
		for (const key of Object.keys(WATCHDOG_DEFAULTS)) {
			const field = fields.find((f) => f.key === key);
			expect(field, `missing schema field for ${key}`).toBeDefined();
			expect(field?.default).toEqual(WATCHDOG_DEFAULTS[key as keyof typeof WATCHDOG_DEFAULTS]);
		}
	});
});
