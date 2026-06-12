import { describe, expect, test } from 'vitest';
import { Incidents } from '../services/incidents.js';
import { Persistence } from '../services/persistence.js';

function build(now: () => number) {
	let n = 0;
	return new Incidents(new Persistence({ path: ':memory:' }).openStore('incidents'), now, () => `id${++n}`);
}

describe('Incident store', () => {
	test('record stamps id, source, and at, and returns the incident', () => {
		const api = build(() => 1234).forExtension('watchdog');
		const rec = api.record({ kind: 'restart', severity: 'warn', summary: 'restarted Pieces' });
		expect(rec).toEqual({
			id: 'id1',
			source: 'watchdog',
			at: 1234,
			kind: 'restart',
			severity: 'warn',
			summary: 'restarted Pieces',
		});
	});

	test('query returns newest-first, filters, and round-trips data', () => {
		let t = 0;
		const api = build(() => t).forExtension('m');
		t = 1000;
		api.record({ kind: 'a', severity: 'info', summary: 'first', data: { x: 1 } });
		t = 2000;
		api.record({ kind: 'b', severity: 'crit', summary: 'second' });
		t = 3000;
		api.record({ kind: 'a', severity: 'warn', summary: 'third' });

		expect(api.query().map((i) => i.summary)).toEqual(['third', 'second', 'first']);
		expect(api.query().at(-1)?.data).toEqual({ x: 1 });
		expect(api.query({ kind: 'a' }).map((i) => i.summary)).toEqual(['third', 'first']);
		expect(api.query({ since: 2500 }).map((i) => i.summary)).toEqual(['third']);
		expect(api.query({ limit: 1 }).map((i) => i.summary)).toEqual(['third']);
	});
});
