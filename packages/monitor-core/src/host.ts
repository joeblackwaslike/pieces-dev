import type { Extension, HostContext } from '@pieces-dev/monitor-sdk';
import type { Services } from './runtime.js';

/**
 * The extension host: builds a namespaced {@link HostContext} per extension and
 * runs its activate/deactivate lifecycle.
 */
export class Host {
	private readonly loaded: Extension[] = [];

	constructor(private readonly services: Services) {}

	contextFor(id: string): HostContext {
		const s = this.services;
		return {
			store: s.store.openStore(id),
			config: s.config.forExtension(id),
			health: s.health.forExtension(id),
			incidents: s.incidents.forExtension(id),
			log: s.log.forExtension(id),
			bus: s.bus.api(),
			schedule: s.scheduler.api(),
			notify: s.notify.api(),
			api: s.api.forExtension(id),
			commands: s.commands.api(),
			process: s.process.api(),
			menu: s.menu.api(),
			dashboard: s.dashboard.forExtension(),
			cli: s.cli.forExtension(),
			pieces: s.pieces.api(),
		};
	}

	async load(extension: Extension): Promise<void> {
		const ctx = this.contextFor(extension.id);
		this.loaded.push(extension);
		await extension.activate(ctx);
	}

	async unloadAll(): Promise<void> {
		for (const extension of [...this.loaded].reverse()) {
			await extension.deactivate?.();
		}
		this.loaded.length = 0;
	}
}
