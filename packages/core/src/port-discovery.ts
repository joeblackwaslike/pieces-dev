import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Platform-aware location of PiecesOS's `.port.txt`. Hardcoding the macOS
 * `~/Library` path made discovery silently fail on Linux/Windows, forcing the
 * slow range probe on every call.
 */
const PORT_FILE_PATH = (() => {
	const home = homedir();
	const segments = ['com.pieces.os', 'production', 'Config', '.port.txt'];
	if (process.platform === 'win32') {
		const base = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
		return join(base, ...segments);
	}
	if (process.platform === 'darwin') {
		return join(home, 'Library', ...segments);
	}
	const base = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
	return join(base, ...segments);
})();

const HEALTH_TIMEOUT_MS = 2000;
const PORT_RANGE_START = 39300;
const PORT_RANGE_END = 39333;

export type PortDiscoveryOptions = {
	portOverride?: number;
};

async function checkHealth(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://localhost:${port}/.well-known/health`, {
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function discoverPort(options?: PortDiscoveryOptions): Promise<number | null> {
	if (options?.portOverride) {
		if (await checkHealth(options.portOverride)) {
			return options.portOverride;
		}
		// Override unhealthy — fall through to file/probe rather than giving up,
		// so a stale override can't disable discovery entirely.
		console.warn(
			`[pieces-dev/core] port override ${options.portOverride} failed health check; falling back to discovery`,
		);
	}

	try {
		const content = await readFile(PORT_FILE_PATH, 'utf-8');
		const port = Number.parseInt(content.trim(), 10);
		if (!Number.isNaN(port) && (await checkHealth(port))) {
			return port;
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(
			`[pieces-dev/core] could not read PiecesOS port file (${PORT_FILE_PATH}): ${reason}; probing port range`,
		);
	}

	// Probe the full range in parallel so a missing PiecesOS resolves in ~2s
	// instead of ~68s (34 ports × 2s sequential timeouts).
	const ports = Array.from(
		{ length: PORT_RANGE_END - PORT_RANGE_START + 1 },
		(_, i) => PORT_RANGE_START + i,
	);
	const healthy = await Promise.all(
		ports.map(async (port) => ((await checkHealth(port)) ? port : null)),
	);
	const found = healthy.find((port): port is number => port !== null);
	if (found !== undefined) {
		return found;
	}

	console.warn(
		`[pieces-dev/core] no healthy PiecesOS port found in range ${PORT_RANGE_START}-${PORT_RANGE_END}`,
	);
	return null;
}
