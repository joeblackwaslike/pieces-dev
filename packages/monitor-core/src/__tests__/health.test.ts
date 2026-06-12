import { describe, expect, test } from 'vitest';
import { Health } from '../services/health.js';

describe('Health rollup', () => {
	test('overall is ok when nothing is reported', () => {
		expect(new Health().overall().state).toBe('ok');
	});

	test('overall is the worst-of every reported check', () => {
		const health = new Health();
		health.forExtension('a').report('a.one', 'ok');
		health.forExtension('a').report('a.two', 'warn');
		expect(health.overall().state).toBe('warn');
		health.forExtension('b').report('b.one', 'crit');
		expect(health.overall().state).toBe('crit');
	});

	test('the latest report for a checkId replaces the previous one', () => {
		const health = new Health();
		const api = health.forExtension('m');
		api.report('m.cpu', 'crit', 'spiking');
		expect(health.overall().state).toBe('crit');
		api.report('m.cpu', 'ok');
		expect(health.overall().state).toBe('ok');
	});

	test('overall lists every reported check with its state and detail', () => {
		const health = new Health();
		health.forExtension('m').report('m.cpu', 'warn', 'high');
		const { checks } = health.overall();
		expect(checks).toHaveLength(1);
		expect(checks[0]).toMatchObject({ checkId: 'm.cpu', state: 'warn', detail: 'high' });
	});
});
