import { describe, expect, test } from 'vitest';
import { type CommandRunner, ProcessControl } from '../services/process.js';

function fake(respond: (cmd: string, args: string[]) => { stdout: string; code: number } | void) {
	const calls: string[][] = [];
	const run: CommandRunner = (cmd, args) => {
		calls.push([cmd, ...args]);
		return respond(cmd, args) ?? { stdout: '', code: 0 };
	};
	return { run, calls };
}

describe('Process control', () => {
	test('listPids parses pgrep output into numbers', () => {
		const { run } = fake((cmd) => (cmd === 'pgrep' ? { stdout: '123\n456\n', code: 0 } : undefined));
		expect(new ProcessControl(run).listPids('Pieces OS')).toEqual([123, 456]);
	});

	test('listPids returns [] when pgrep matches nothing (exit 1)', () => {
		const { run } = fake(() => ({ stdout: '', code: 1 }));
		expect(new ProcessControl(run).listPids('x')).toEqual([]);
	});

	test('launchPieces is guarded — no `open` when Pieces is already running', async () => {
		const { run, calls } = fake((cmd) => (cmd === 'pgrep' ? { stdout: '1\n', code: 0 } : undefined));
		await new ProcessControl(run).launchPieces();
		expect(calls.some((c) => c[0] === 'open')).toBe(false);
	});

	test('launchPieces opens via `open -a` when Pieces is not running', async () => {
		const { run, calls } = fake((cmd) => (cmd === 'pgrep' ? { stdout: '', code: 1 } : undefined));
		await new ProcessControl(run).launchPieces();
		expect(calls).toContainEqual(['open', '-a', 'Pieces OS']);
	});

	test('stopPieces sends SIGTERM to each running pid', async () => {
		const { run, calls } = fake((cmd) =>
			cmd === 'pgrep' ? { stdout: '10\n11\n', code: 0 } : undefined,
		);
		await new ProcessControl(run).stopPieces();
		expect(calls).toContainEqual(['kill', '10']);
		expect(calls).toContainEqual(['kill', '11']);
	});
});
