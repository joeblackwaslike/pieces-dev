import { describe, expect, it } from 'vitest';
import { EventQueue } from '../event-queue.js';

const makeEvent = () => ({
  application: { id: '1', name: 'VS_CODE', version: '1', platform: 'MACOS' as const },
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
});
