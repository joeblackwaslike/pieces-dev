import { describe, expect, test } from 'vitest';
import { Commands } from '../services/commands.js';

describe('Command registry', () => {
	test('register then dispatch runs the handler with params and returns its result', async () => {
		const commands = new Commands();
		let got: unknown;
		commands.api().register({
			id: 'm.ping',
			title: 'Ping',
			handler: (params) => {
				got = params;
				return 'pong';
			},
		});
		await expect(commands.dispatch('m.ping', { x: 1 })).resolves.toBe('pong');
		expect(got).toEqual({ x: 1 });
	});

	test('dispatching an unknown command rejects', async () => {
		await expect(new Commands().dispatch('nope')).rejects.toThrow();
	});

	test('list returns the registered commands', () => {
		const commands = new Commands();
		commands.api().register({ id: 'm.a', title: 'A', handler: () => {} });
		expect(commands.list().map((c) => c.id)).toEqual(['m.a']);
	});
});
