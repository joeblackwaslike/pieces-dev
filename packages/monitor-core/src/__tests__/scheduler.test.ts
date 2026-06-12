import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Scheduler } from '../services/scheduler.js';

describe('Scheduler', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test('fires on the interval and stops on cancel', () => {
		const scheduler = new Scheduler();
		let n = 0;
		const handle = scheduler.api().schedule({ everyMs: 1000 }, () => {
			n++;
		});
		vi.advanceTimersByTime(3000);
		expect(n).toBe(3);
		handle.cancel();
		vi.advanceTimersByTime(2000);
		expect(n).toBe(3);
	});

	test('a throwing handler is reported but does not stop the schedule', () => {
		const errors: unknown[] = [];
		const scheduler = new Scheduler((e) => errors.push(e));
		let n = 0;
		scheduler.api().schedule({ everyMs: 1000 }, () => {
			n++;
			if (n === 1) throw new Error('boom');
		});
		vi.advanceTimersByTime(2000);
		expect(n).toBe(2);
		expect(errors).toHaveLength(1);
	});

	test('cron scheduling is rejected for now', () => {
		expect(() => new Scheduler().api().schedule({ cron: '* * * * *' }, () => {})).toThrow();
	});
});
