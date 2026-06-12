import { describe, expect, test } from 'vitest';
import { EventBus } from '../services/event-bus.js';

describe('Event bus', () => {
	test('delivers a payload only to subscribers of that event', () => {
		const bus = new EventBus();
		const api = bus.api();
		const seen: unknown[] = [];
		api.on('data-integrity.suspect', (p) => seen.push(p));
		api.emit('data-integrity.suspect', { id: 'couchbase' });
		api.emit('other.event', { id: 'x' });
		expect(seen).toEqual([{ id: 'couchbase' }]);
	});

	test('unsubscribe stops delivery', () => {
		const bus = new EventBus();
		const api = bus.api();
		let count = 0;
		const off = api.on('e', () => count++);
		api.emit('e');
		off();
		api.emit('e');
		expect(count).toBe(1);
	});

	test('onAny observes every emitted event (for the WS bridge)', () => {
		const bus = new EventBus();
		const seen: Array<[string, unknown]> = [];
		bus.onAny((event, payload) => seen.push([event, payload]));
		bus.api().emit('a', 1);
		bus.api().emit('b', 2);
		expect(seen).toEqual([
			['a', 1],
			['b', 2],
		]);
	});
});
