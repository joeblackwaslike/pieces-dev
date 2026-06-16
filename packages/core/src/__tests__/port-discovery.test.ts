import { describe, expect, it, vi } from 'vitest';
import { discoverPort } from '../port-discovery.js';

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(),
}));

describe('discoverPort', () => {
	it('reads port from .port.txt file', async () => {
		const { readFile } = await import('node:fs/promises');
		vi.mocked(readFile).mockResolvedValue('39312\n');

		const mockFetch = vi
			.fn()
			.mockResolvedValue({ ok: true, text: () => Promise.resolve('ok:uuid') });
		vi.stubGlobal('fetch', mockFetch);

		const port = await discoverPort();
		expect(port).toBe(39312);

		vi.unstubAllGlobals();
	});

	it('returns override port without reading file', async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValue({ ok: true, text: () => Promise.resolve('ok:uuid') });
		vi.stubGlobal('fetch', mockFetch);

		const port = await discoverPort({ portOverride: 39300 });
		expect(port).toBe(39300);
		expect(mockFetch).toHaveBeenCalledWith(
			'http://localhost:39300/.well-known/health',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		vi.unstubAllGlobals();
	});

	it('falls back to .port.txt when the override is unhealthy', async () => {
		const { readFile } = await import('node:fs/promises');
		vi.mocked(readFile).mockResolvedValue('39312\n');

		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce({ ok: false }) // override health fails
			.mockResolvedValueOnce({ ok: true }); // file-derived port health succeeds
		vi.stubGlobal('fetch', mockFetch);

		const port = await discoverPort({ portOverride: 39300 });
		expect(port).toBe(39312);
		expect(mockFetch).toHaveBeenNthCalledWith(
			1,
			'http://localhost:39300/.well-known/health',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		vi.unstubAllGlobals();
	});

	it('returns null when file missing and health check fails', async () => {
		const { readFile } = await import('node:fs/promises');
		vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

		const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
		vi.stubGlobal('fetch', mockFetch);

		const port = await discoverPort();
		expect(port).toBeNull();

		vi.unstubAllGlobals();
	});
});
