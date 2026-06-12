import { execFileSync } from 'node:child_process';
import type { KillSignal, ProcessApi, RestartMode } from '@pieces-dev/monitor-sdk';

const PIECES_APP = 'Pieces OS';
const PIECES_DESKTOP_APP = 'Pieces';
/** How often `killPieces` re-checks whether the signalled pids have exited. */
const KILL_POLL_MS = 500;

export interface RunResult {
	stdout: string;
	code: number;
}

export type CommandRunner = (cmd: string, args: string[]) => RunResult;
export type Sleep = (ms: number) => Promise<void>;
export type Clock = () => number;

/**
 * Process control: the hardened, single-launcher Pieces lifecycle. Every launch
 * goes through `open -a` (which respects `LSMultipleInstancesProhibited`) behind
 * a pre-launch PID guard, so no caller can recreate the dual-instance DB-wipe
 * bug. The command runner is injectable for testing.
 */
export class ProcessControl {
	constructor(
		private readonly run: CommandRunner = defaultRunner,
		private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		private readonly now: Clock = () => Date.now(),
	) {}

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

	/**
	 * Signal every Pieces OS pid (`-TERM` or `-KILL`) and poll until they exit or
	 * `waitMs` elapses. Returns the still-alive pids — empty means a clean exit.
	 * Waiting for exit before any relaunch is what keeps the guarded `launchPieces`
	 * from racing a still-dying process.
	 */
	async killPieces(signal: KillSignal, waitMs = 10_000): Promise<number[]> {
		const flag = signal === 'kill' ? '-KILL' : '-TERM';
		for (const pid of this.listPids(PIECES_APP)) {
			this.run('kill', [flag, String(pid)]);
		}
		const start = this.now();
		while (true) {
			const remaining = this.listPids(PIECES_APP);
			if (remaining.length === 0) return [];
			if (this.now() - start >= waitMs) return remaining;
			await this.sleep(KILL_POLL_MS);
		}
	}

	/** Open the Pieces Desktop app (its re-login UI), distinct from the headless OS service. */
	async openApp(): Promise<void> {
		this.run('open', ['-a', PIECES_DESKTOP_APP]);
	}

	async restartPieces(mode: RestartMode = 'term'): Promise<void> {
		await this.killPieces(mode === 'kill' ? 'kill' : 'term');
		await this.launchPieces();
	}

	api(): ProcessApi {
		return {
			listPids: (matcher) => this.listPids(matcher),
			isPiecesRunning: () => this.isPiecesRunning(),
			launchPieces: () => this.launchPieces(),
			stopPieces: () => this.stopPieces(),
			killPieces: (signal, waitMs) => this.killPieces(signal, waitMs),
			openApp: () => this.openApp(),
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
