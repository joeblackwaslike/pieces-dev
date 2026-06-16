import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiecesClient } from '../client.js';

describe('PiecesClient', () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal('fetch', mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('postEvent sends SeededWorkstreamEvent and returns event id', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: 'evt-123' }),
		});

		const client = new PiecesClient(39312);
		const id = await client.postEvent({
			application: { id: 'app-1', name: 'VS_CODE', version: '1.0', platform: 'MACOS' },
			trigger: { check_in: true },
			readable: 'test',
		});

		expect(id).toBe('evt-123');
		expect(mockFetch).toHaveBeenCalledWith(
			'http://localhost:39312/workstream_events/create',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	});

	it('postEvent returns null on network error', async () => {
		mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

		const client = new PiecesClient(39312);
		const id = await client.postEvent({
			application: { id: 'app-1', name: 'VS_CODE', version: '1.0', platform: 'MACOS' },
			trigger: { check_in: true },
		});

		expect(id).toBeNull();
	});

	it('deleteEvent posts to correct URL and returns true on 204', async () => {
		mockFetch.mockResolvedValue({ ok: true, status: 204 });

		const client = new PiecesClient(39312);
		const result = await client.deleteEvent('evt-123');

		expect(result).toBe(true);
		expect(mockFetch).toHaveBeenCalledWith(
			'http://localhost:39312/workstream_events/evt-123/delete',
			expect.objectContaining({ method: 'POST' }),
		);
	});

	it('triggerSummary sends time range', async () => {
		mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

		const client = new PiecesClient(39312);
		const from = new Date('2026-05-27T00:00:00Z');
		const to = new Date('2026-05-27T23:59:59Z');
		const result = await client.triggerSummary(from, to);

		expect(result).toBe(true);
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body).toHaveProperty('anonymous_ranges');
		// Timestamps must be wrapped as GroupedTimestamp `{ value }`, not bare ISO strings.
		expect(body.anonymous_ranges[0].from).toEqual({ value: from.toISOString() });
		expect(body.anonymous_ranges[0].to).toEqual({ value: to.toISOString() });
	});

	it('getEvents returns the iterable array', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ iterable: [{ id: 'a' }, { id: 'b' }] }),
		});

		const client = new PiecesClient(39312);
		expect(await client.getEvents()).toEqual([{ id: 'a' }, { id: 'b' }]);
	});

	it('getEvents returns [] when iterable is not an array', async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ iterable: { not: 'an array' } }),
		});

		const client = new PiecesClient(39312);
		expect(await client.getEvents()).toEqual([]);
	});
});
