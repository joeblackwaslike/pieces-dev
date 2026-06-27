import { describe, expect, test } from 'vitest';
import { Log } from '../services/log.js';
import { Persistence } from '../services/persistence.js';

function build(now: () => number): Log {
	return new Log(new Persistence({ path: ':memory:' }).openStore('log'), now);
}

describe('Log service', () => {
	test('records entries newest-first and round-trips data', () => {
		let t = 0;
		const api = build(() => t).forExtension('metrics');
		t = 1000;
		api.info('sampled', { cpu: 0.5 });
		t = 2000;
		api.warn('cpu high');
		const rows = api.query();
		expect(rows.map((r) => r.message)).toEqual(['cpu high', 'sampled']);
		expect(rows.at(-1)).toMatchObject({ level: 'info', source: 'metrics', data: { cpu: 0.5 } });
	});

	test('filters by level and since', () => {
		let t = 0;
		const api = build(() => t).forExtension('m');
		t = 1000;
		api.debug('d');
		t = 2000;
		api.error('boom');
		expect(api.query({ level: 'error' }).map((r) => r.message)).toEqual(['boom']);
		expect(api.query({ since: 1500 }).map((r) => r.message)).toEqual(['boom']);
	});
});
