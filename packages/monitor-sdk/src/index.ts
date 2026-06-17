/**
 * `@pieces-dev/monitor-sdk` — the stable contract every Pieces Monitor extension
 * imports. Pure types and no runtime dependencies.
 */

import type {
	ApiApi,
	CliApi,
	CommandApi,
	ConfigApi,
	DashboardApi,
	EventBusApi,
	HealthApi,
	IncidentApi,
	LogApi,
	MenuApi,
	NotifyApi,
	PiecesApi,
	ProcessApi,
	SchedulerApi,
	StoreApi,
} from './services.js';

export * from './services.js';
export * from './types.js';

/**
 * Everything an extension receives at activation. Grouped by concern:
 * data & state, observability, eventing & scheduling, surfaces & control,
 * and the Pieces integration handle.
 */
export interface HostContext {
	// data & state
	store: StoreApi;
	config: ConfigApi;
	// observability
	health: HealthApi;
	incidents: IncidentApi;
	log: LogApi;
	// eventing & scheduling
	bus: EventBusApi;
	schedule: SchedulerApi;
	notify: NotifyApi;
	// surfaces & control
	api: ApiApi;
	commands: CommandApi;
	process: ProcessApi;
	menu: MenuApi;
	dashboard: DashboardApi;
	cli: CliApi;
	// integration
	pieces: PiecesApi;
}

/** A Pieces Monitor extension: one in-process TS module. */
export interface Extension {
	id: string;
	name: string;
	version: string;
	activate(ctx: HostContext): void | Promise<void>;
	deactivate?(): void | Promise<void>;
}
