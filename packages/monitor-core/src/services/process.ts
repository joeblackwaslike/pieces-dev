import { execFileSync } from 'node:child_process';
import type { ProcessApi, RestartMode } from '@pieces-dev/monitor-sdk';

const PIECES_APP = 'Pieces OS';

export interface RunResult {
	stdout: string;
	code: number;
}

export type CommandRunner = (cmd: string, args: string[]) => RunResult;

/**
 * Process control: the hardened, single-launcher Pieces lifecycle. Every launch
 * goes through `open -a` (which respects `LSMultipleInstancesProhibited`) behind
 * a pre-launch PID guard, so no caller can recreate the dual-instance DB-wipe
 * bug. The command runner is injectable for testing.
 */
export class ProcessControl {
	constructor(private readonly run: CommandRunner = defaultRunner) {}

	listPids(matcher: string): number[] {
		const { stdout, code } = this.run('pgrep', ['-f', matcher]);
		if (code !== 0) return [];
		return stdout
			.trim()
			.split('\n')
			.map((line) => Number(line.trim()))
			.filter((n) => Number.isInteger(n) && n > 0);
	}

	isPiecesRunning(): boolean {
		return this.listPids(PIECES_APP).length > 0;
	}

	async launchPieces(): Promise<void> {
		// Pre-launch guard: never spawn a second instance.
		if (this.isPiecesRunning()) return;
		this.run('open', ['-a', PIECES_APP]);
	}

	async stopPieces(): Promise<void> {
		for (const pid of this.listPids(PIECES_APP)) {
			this.run('kill', [String(pid)]);
		}
	}

	async restartPieces(mode: RestartMode = 'term'): Promise<void> {
		void mode; // escalation modes land with the watchdog extension.
		await this.stopPieces();
		await this.launchPieces();
	}

	api(): ProcessApi {
		return {
			listPids: (matcher) => this.listPids(matcher),
			isPiecesRunning: () => this.isPiecesRunning(),
			launchPieces: () => this.launchPieces(),
			stopPieces: () => this.stopPieces(),
			restartPieces: (mode) => this.restartPieces(mode),
		};
	}
}

function defaultRunner(cmd: string, args: string[]): RunResult {
	try {
		const stdout = execFileSync(cmd, args, { encoding: 'utf8' });
		return { stdout, code: 0 };
	} catch (error) {
		const e = error as { stdout?: Buffer | string; status?: number };
		return { stdout: e.stdout?.toString() ?? '', code: typeof e.status === 'number' ? e.status : 1 };
	}
}
