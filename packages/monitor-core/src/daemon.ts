import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extensions } from './extensions.js';
import { Host } from './host.js';
import { buildServices } from './runtime.js';
import { buildServer } from './server.js';

const PORT = 4747;
const DIR = join(homedir(), 'Library/Application Support/PiecesMonitor');

/** Read the loopback bearer token, creating a chmod-600 file on first run. */
function ensureToken(): string {
	mkdirSync(DIR, { recursive: true });
	const file = join(DIR, 'token');
	if (existsSync(file)) return readFileSync(file, 'utf8').trim();
	const token = randomUUID();
	writeFileSync(file, token, { mode: 0o600 });
	chmodSync(file, 0o600);
	return token;
}

/** Boot the daemon: build services, register the built-in proof-of-host, listen on loopback. */
export async function startDaemon(): Promise<void> {
	const services = buildServices({
		dbPath: join(DIR, 'monitor.db'),
		configPath: join(DIR, 'config.json'),
	});

	// Built-in proof-of-host: a trivial health check, command, and menu item.
	services.health.forExtension('core').report('core.hello', 'ok', 'daemon up');
	services.commands.api().register({ id: 'ping', title: 'Ping', handler: () => 'pong' });
	services.menu.api().contribute(() => ({
		title: 'Pieces Monitor',
		items: [
			{ label: 'Open Dashboard', action: { type: 'open-url', url: `http://127.0.0.1:${PORT}/` } },
		],
	}));
	services.incidents.forExtension('core').record({
		kind: 'daemon-start',
		severity: 'info',
		summary: 'Pieces Monitor daemon started',
	});

	// Load extensions before building the server: `buildServer` mounts
	// `services.api.routes` once, so any routes an extension registers during
	// `activate` must already be present.
	const host = new Host(services);
	for (const extension of extensions) {
		await host.load(extension);
	}

	const app = buildServer(services, { token: ensureToken() });

	const shutdown = async (): Promise<void> => {
		await host.unloadAll();
		await app.close();
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
	try {
		await app.listen({ host: '127.0.0.1', port: PORT });
		console.log(`Pieces Monitor daemon listening on http://127.0.0.1:${PORT}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
			console.error(`Port ${PORT} is in use — another daemon is already running. Exiting.`);
			process.exit(1);
		}
		throw error;
	}
}

if (import.meta.main) {
	startDaemon().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
