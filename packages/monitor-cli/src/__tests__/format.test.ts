import { describe, expect, test } from 'vitest';
import { renderIncidents, renderStatus, statusExitCode } from '../format.js';

describe('CLI formatting', () => {
	test('exit code maps ok→0, warn→1, crit→2', () => {
		expect(statusExitCode('ok')).toBe(0);
		expect(statusExitCode('warn')).toBe(1);
		expect(statusExitCode('crit')).toBe(2);
	});

	test('renderStatus shows the overall state and each check with its detail', () => {
		const out = renderStatus({
			state: 'warn',
			at: 0,
			checks: [
				{ checkId: 'core.hello', state: 'ok', at: 0 },
				{ checkId: 'metrics.cpu', state: 'warn', detail: 'hot', at: 0 },
			],
		});
		expect(out).toContain('warn');
		expect(out).toContain('core.hello');
		expect(out).toContain('metrics.cpu');
		expect(out).toContain('hot');
	});

	test('renderIncidents lists each incident, newest first', () => {
		const out = renderIncidents([
			{ id: '1', source: 'core', kind: 'daemon-start', severity: 'info', summary: 'started', at: 0 },
		]);
		expect(out).toContain('daemon-start');
		expect(out).toContain('started');
	});

	test('renderIncidents handles an empty list', () => {
		expect(renderIncidents([])).toContain('No incidents');
	});
});
