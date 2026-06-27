import { execFileSync } from 'node:child_process';

export type Runner = (cmd: string, args: string[]) => string;

const defaultRunner: Runner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

/** Parse macOS `ioreg -c IOHIDSystem` output → seconds since the last HID event. */
export function parseHidIdle(ioregOutput: string): number | null {
	const match = ioregOutput.match(/"HIDIdleTime"\s*=\s*(\d+)/);
	if (!match) return null;
	return Number(match[1]) / 1e9;
}

/** Seconds the user has been idle (no HID input). Returns 0 if it cannot be determined. */
export function idleSeconds(run: Runner = defaultRunner): number {
	try {
		const out = run('ioreg', ['-c', 'IOHIDSystem']);
		return parseHidIdle(out) ?? 0;
	} catch {
		return 0;
	}
}
