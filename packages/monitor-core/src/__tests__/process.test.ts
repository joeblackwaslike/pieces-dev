import { describe, expect, test } from 'vitest';
import { type CommandRunner, ProcessControl } from '../services/process.js';

function fake(
	respond: (cmd: string, args: string[]) => { stdout: string; code: number } | undefined,
) {
	const calls: string[][] = [];
	const run: CommandRunner = (cmd, args) => {
		calls.push([cmd, ...args]);
		return respond(cmd, args) ?? { stdout: '', code: 0 };
	};
	return { run, calls };
}

/** A runner whose successive `pgrep` calls return each line of `outputs` in turn
 *  (the last entry sticks). Non-pgrep commands succeed with empty output. */
function pgrepSequence(outputs: string[]) {
	let i = 0;
	return fake((cmd) => {
		if (cmd !== 'pgrep') return undefined;
		const stdout = outputs[Math.min(i, outputs.length - 1)] ?? '';
		i++;
		return { stdout, code: stdout.trim() === '' ? 1 : 0 };
	});
}

/** Sleep stub that resolves immediately — keeps poll loops deterministic. */
const noSleep = async (): Promise<void> => {};

describe('Process control', () => {
	test('listPids parses pgrep output into numbers', () => {
		const { run } = fake((cmd) =>
			cmd === 'pgrep' ? { stdout: '123\n456\n', code: 0 } : undefined,
		);
		expect(new ProcessControl(run).listPids('Pieces OS')).toEqual([123, 456]);
	});

	test('listPids returns [] when pgrep matches nothing (exit 1)', () => {
		const { run } = fake(() => ({ stdout: '', code: 1 }));
		expect(new ProcessControl(run).listPids('x')).toEqual([]);
	});

	test('internal kill paths pgrep on the bundle-path-anchored matcher, not bare "Pieces OS"', () => {
		const { run, calls } = fake((cmd) => (cmd === 'pgrep' ? { stdout: '', code: 1 } : undefined));
		new ProcessControl(run).isPiecesRunning();
		expect(calls).toContainEqual(['pgrep', '-f', 'Pieces OS.app/Contents/MacOS']);
		expect(calls).not.toContainEqual(['pgrep', '-f', 'Pieces OS']);
	});

	test('launchPieces is guarded — no `open` when Pieces is already running', async () => {
		const { run, calls } = fake((cmd) =>
			cmd === 'pgrep' ? { stdout: '1\n', code: 0 } : undefined,
		);
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

	test('openApp opens the Pieces desktop app via `open -a Pieces`', async () => {
		const { run, calls } = fake(() => undefined);
		await new ProcessControl(run).openApp();
		expect(calls).toContainEqual(['open', '-a', 'Pieces']);
	});

	test('killPieces("term") sends SIGTERM (kill -TERM) to each pid', async () => {
		// pgrep returns pids once, then empty (process exited) so the poll resolves.
		const { run, calls } = pgrepSequence(['10\n11\n', '']);
		const survivors = await new ProcessControl(run, noSleep).killPieces('term');
		expect(calls).toContainEqual(['kill', '-TERM', '10']);
		expect(calls).toContainEqual(['kill', '-TERM', '11']);
		expect(survivors).toEqual([]);
	});

	test('killPieces("kill") sends SIGKILL (kill -KILL) to each pid', async () => {
		const { run, calls } = pgrepSequence(['7\n', '']);
		await new ProcessControl(run, noSleep).killPieces('kill');
		expect(calls).toContainEqual(['kill', '-KILL', '7']);
	});

	test('killPieces resolves with [] once the pids disappear', async () => {
		// Alive on first poll, gone on the second.
		const { run } = pgrepSequence(['10\n', '10\n', '']);
		const survivors = await new ProcessControl(run, noSleep).killPieces('term');
		expect(survivors).toEqual([]);
	});

	test('killPieces returns survivors when pids never clear before the deadline', async () => {
		// Always alive; injected clock advances past waitMs so the loop gives up.
		const { run } = fake((cmd) => (cmd === 'pgrep' ? { stdout: '99\n', code: 0 } : undefined));
		let t = 0;
		const clock = () => t;
		const sleep = async (ms: number) => {
			t += ms;
		};
		const survivors = await new ProcessControl(run, sleep, clock).killPieces('term', 1000);
		expect(survivors).toEqual([99]);
	});

	test('restartPieces("kill") SIGKILLs then launches', async () => {
		// pids present for the kill, gone for the launch guard.
		const { run, calls } = pgrepSequence(['5\n', '']);
		await new ProcessControl(run, noSleep).restartPieces('kill');
		expect(calls).toContainEqual(['kill', '-KILL', '5']);
		expect(calls).toContainEqual(['open', '-a', 'Pieces OS']);
	});

	test('restartPieces("term") SIGTERMs then launches', async () => {
		const { run, calls } = pgrepSequence(['5\n', '']);
		await new ProcessControl(run, noSleep).restartPieces('term');
		expect(calls).toContainEqual(['kill', '-TERM', '5']);
		expect(calls).toContainEqual(['open', '-a', 'Pieces OS']);
	});
});
