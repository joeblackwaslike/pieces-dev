import type { WorkstreamEventInput } from '@pieces-dev/core';
import { describe, expect, it } from 'vitest';
import { EventQueue } from '../event-queue.js';

const makeEvent = (): WorkstreamEventInput => ({
	application: { id: '1', name: 'VS_CODE', version: '1', platform: 'MACOS' },
	trigger: { check_in: true },
});

describe('EventQueue', () => {
	it('enqueues and drains in FIFO order', async () => {
		const queue = new EventQueue(10);
		queue.enqueue({ ...makeEvent(), readable: 'first' });
		queue.enqueue({ ...makeEvent(), readable: 'second' });

		const drained: string[] = [];
		await queue.drain(async (evt) => {
			drained.push(evt.readable ?? '');
		});

		expect(drained).toEqual(['first', 'second']);
		expect(queue.size).toBe(0);
	});

	it('drops oldest when full', () => {
		const queue = new EventQueue(2);
		queue.enqueue({ ...makeEvent(), readable: 'a' });
		queue.enqueue({ ...makeEvent(), readable: 'b' });
		queue.enqueue({ ...makeEvent(), readable: 'c' });

		expect(queue.size).toBe(2);
	});

	it('drains the newer events when full (oldest dropped)', async () => {
		const queue = new EventQueue(2);
		queue.enqueue({ ...makeEvent(), readable: 'a' });
		queue.enqueue({ ...makeEvent(), readable: 'b' });
		queue.enqueue({ ...makeEvent(), readable: 'c' });

		const drained: string[] = [];
		await queue.drain(async (evt) => {
			drained.push(evt.readable ?? '');
		});

		expect(drained).toEqual(['b', 'c']);
	});

	it('reports correct size', () => {
		const queue = new EventQueue(5);
		expect(queue.size).toBe(0);
		queue.enqueue(makeEvent());
		expect(queue.size).toBe(1);
	});

	it('preserves events when the drain callback throws mid-drain', async () => {
		const queue = new EventQueue(10);
		queue.enqueue({ ...makeEvent(), readable: 'first' });
		queue.enqueue({ ...makeEvent(), readable: 'second' });

		const seen: string[] = [];
		await expect(
			queue.drain(async (evt) => {
				seen.push(evt.readable ?? '');
				if (evt.readable === 'second') throw new Error('network down');
			}),
		).rejects.toThrow('network down');

		// 'first' drained successfully and was removed; 'second' failed and must
		// remain at the head of the queue for the next drain attempt.
		expect(seen).toEqual(['first', 'second']);
		expect(queue.size).toBe(1);

		const retried: string[] = [];
		await queue.drain(async (evt) => {
			retried.push(evt.readable ?? '');
		});
		expect(retried).toEqual(['second']);
		expect(queue.size).toBe(0);
	});
});
