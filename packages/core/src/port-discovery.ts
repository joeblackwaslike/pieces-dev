import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT_FILE_PATH = join(
  homedir(),
  'Library/com.pieces.os/production/Config/.port.txt',
);
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

export async function discoverPort(
  options?: PortDiscoveryOptions,
): Promise<number | null> {
  if (options?.portOverride) {
    const healthy = await checkHealth(options.portOverride);
    return healthy ? options.portOverride : null;
  }

  try {
    const content = await readFile(PORT_FILE_PATH, 'utf-8');
    const port = Number.parseInt(content.trim(), 10);
    if (!Number.isNaN(port) && (await checkHealth(port))) {
      return port;
    }
  } catch {
    // .port.txt missing or unreadable — fall through to probe
  }

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await checkHealth(port)) {
      return port;
    }
  }

  return null;
}
