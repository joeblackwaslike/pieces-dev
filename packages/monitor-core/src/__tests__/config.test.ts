import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Config } from '../services/config.js';

describe('Config store', () => {
	test('get falls back to the registered schema default until a value is set', () => {
		const api = new Config().forExtension('metrics');
		api.registerSchema({
			sections: [
				{
					id: 'general',
					title: 'General',
					fields: [{ key: 'sampleMs', label: 'Sample interval', type: 'number', default: 30_000 }],
				},
			],
		});
		expect(api.get('sampleMs')).toBe(30_000);
		api.set('sampleMs', 5_000);
		expect(api.get('sampleMs')).toBe(5_000);
		expect(api.get('unknown')).toBeUndefined();
	});

	test('onChange fires on set and stops after unsubscribe', () => {
		const api = new Config().forExtension('x');
		const seen: Array<[string, unknown]> = [];
		const off = api.onChange((key, value) => seen.push([key, value]));
		api.set('a', 1);
		expect(seen).toEqual([['a', 1]]);
		off();
		api.set('a', 2);
		expect(seen).toEqual([['a', 1]]);
	});

	test('namespaces are isolated', () => {
		const cfg = new Config();
		const a = cfg.forExtension('a');
		const b = cfg.forExtension('b');
		a.set('k', 'va');
		b.set('k', 'vb');
		expect(a.get('k')).toBe('va');
		expect(b.get('k')).toBe('vb');
		expect(a.all()).toEqual({ k: 'va' });
	});

	test('values persist to disk and reload from the same path', () => {
		const file = join(tmpdir(), `pmon-config-test-${process.pid}.json`);
		try {
			new Config({ path: file }).forExtension('x').set('a', 1);
			const reloaded = new Config({ path: file }).forExtension('x');
			expect(reloaded.get('a')).toBe(1);
		} finally {
			rmSync(file, { force: true });
		}
	});
});
