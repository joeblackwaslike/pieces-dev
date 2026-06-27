import { CliRegistry, DashboardRegistry, MenuRegistry } from './registries.js';
import { ApiRegistry } from './services/api-registry.js';
import { Commands } from './services/commands.js';
import { Config } from './services/config.js';
import { EventBus } from './services/event-bus.js';
import { Health } from './services/health.js';
import { Incidents } from './services/incidents.js';
import { Log } from './services/log.js';
import { Notify } from './services/notify.js';
import { Persistence } from './services/persistence.js';
import { Pieces } from './services/pieces.js';
import { ProcessControl } from './services/process.js';
import { Scheduler } from './services/scheduler.js';

/** The bundle of every core service + contribution registry. */
export interface Services {
	store: Persistence;
	config: Config;
	health: Health;
	incidents: Incidents;
	log: Log;
	bus: EventBus;
	scheduler: Scheduler;
	commands: Commands;
	notify: Notify;
	process: ProcessControl;
	pieces: Pieces;
	menu: MenuRegistry;
	dashboard: DashboardRegistry;
	cli: CliRegistry;
	api: ApiRegistry;
}

export interface BuildOptions {
	/** SQLite path, or `:memory:` (default). */
	dbPath?: string;
	/** Config JSON path, or in-memory (default). */
	configPath?: string;
}

/** Construct every core service, wiring incidents/log onto the shared store. */
export function buildServices(options: BuildOptions = {}): Services {
	const store = new Persistence({ path: options.dbPath });
	return {
		store,
		config: new Config(options.configPath ? { path: options.configPath } : {}),
		health: new Health(),
		incidents: new Incidents(store.openStore('incidents')),
		log: new Log(store.openStore('log')),
		bus: new EventBus(),
		scheduler: new Scheduler(),
		commands: new Commands(),
		notify: new Notify(),
		process: new ProcessControl(),
		pieces: new Pieces(),
		menu: new MenuRegistry(),
		dashboard: new DashboardRegistry(),
		cli: new CliRegistry(),
		api: new ApiRegistry(),
	};
}
