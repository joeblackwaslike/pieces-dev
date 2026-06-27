/**
 * The 11 core service interfaces plus the contribution surfaces, as exposed to
 * an extension through its {@link HostContext}. Implementations live in
 * `@pieces-dev/monitor-core`; this package only defines the contract.
 */

import type {
	Command,
	HealthState,
	Incident,
	IncidentInput,
	IncidentQuery,
	LogEntry,
	LogQuery,
	MenuSection,
	NotificationInput,
	SettingsSchema,
} from './types.js';

/** Values bindable as SQLite parameters. */
export type SqlParam = number | string | bigint | null | Uint8Array;

/**
 * 1. Persistence — a thin shim over SQLite. Each extension (and core service)
 * gets a handle scoped to its own namespace; migrations are tracked per
 * namespace so they run exactly once.
 */
export interface StoreApi {
	/** Apply `statements` once for this namespace if `version` hasn't run yet. */
	migrate(version: number, statements: string[]): void;
	run(sql: string, ...params: SqlParam[]): void;
	get<T = unknown>(sql: string, ...params: SqlParam[]): T | undefined;
	all<T = unknown>(sql: string, ...params: SqlParam[]): T[];
	/** Delete rows whose `tsColumn` (epoch ms) is older than `olderThanMs` ago. Returns rows removed. */
	prune(table: string, tsColumn: string, olderThanMs: number): number;
}

/** 2. Config store — schema-validated, namespaced settings with live reload. */
export interface ConfigApi {
	registerSchema(schema: SettingsSchema): void;
	get<T = unknown>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	all(): Record<string, unknown>;
	onChange(handler: (key: string, value: unknown) => void): () => void;
}

/** 3. Health rollup — extensions report; the daemon aggregates worst-of. */
export interface HealthApi {
	report(checkId: string, state: HealthState, detail?: string): void;
}

/** 4. Incident store — the structured "when & why" timeline. */
export interface IncidentApi {
	record(input: IncidentInput): Incident;
	query(query?: IncidentQuery): Incident[];
}

/** 5. Log service — structured, queryable per-extension logs. Also the logger. */
export interface LogApi {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
	query(query?: LogQuery): LogEntry[];
}

/** 6. Event bus — cross-extension pub/sub; also feeds the WS `/events` push. */
export interface EventBusApi {
	emit(event: string, payload?: unknown): void;
	/** Subscribe; returns an unsubscribe function. */
	on(event: string, handler: (payload: unknown) => void): () => void;
}

export type ScheduleSpec = { everyMs: number } | { cron: string };

export interface ScheduleHandle {
	cancel(): void;
}

/** 7. Scheduler — one shared interval/cron engine. */
export interface SchedulerApi {
	schedule(spec: ScheduleSpec, handler: () => void | Promise<void>): ScheduleHandle;
}

/** 8. Notification service — dedups + rate-limits, then presents. */
export interface NotifyApi {
	notify(input: NotificationInput): void;
}

export interface ApiRequest {
	params: Record<string, string>;
	query: Record<string, string | string[] | undefined>;
	body: unknown;
	headers: Record<string, string | undefined>;
}

export interface ApiResponse {
	status?: number;
	json?: unknown;
	body?: string;
	headers?: Record<string, string>;
}

export type ApiHandler = (req: ApiRequest) => ApiResponse | Promise<ApiResponse>;

export interface ApiSocket {
	send(data: string): void;
	onMessage(handler: (data: string) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

export type WsHandler = (socket: ApiSocket) => void;

/** 9. API service — register namespaced HTTP/WS endpoints under `/api/ext/<id>`. */
export interface ApiApi {
	get(path: string, handler: ApiHandler): void;
	post(path: string, handler: ApiHandler): void;
	ws(path: string, handler: WsHandler): void;
}

/** 10. Command registry — one verb invokable from every surface. */
export interface CommandApi {
	register(command: Command): void;
}

export type RestartMode = 'soft' | 'term' | 'kill';

/** Signal to send when forcibly stopping Pieces OS: `term` = SIGTERM, `kill` = SIGKILL. */
export type KillSignal = 'term' | 'kill';

/**
 * 11. Process control — hardened, single-launcher Pieces lifecycle. All launch
 * goes through `open -a` (respects `LSMultipleInstancesProhibited`) with a
 * pre-launch PID guard, so no extension can recreate the dual-instance bug.
 */
export interface ProcessApi {
	/** PIDs of processes whose command matches `matcher` (e.g. `Pieces OS`). */
	listPids(matcher: string): number[];
	isPiecesRunning(): boolean;
	launchPieces(): Promise<void>;
	stopPieces(): Promise<void>;
	/**
	 * Signal every running Pieces OS pid and resolve once they have exited
	 * (bounded by `waitMs`). Returns the pids still alive at the deadline — an
	 * empty array means a clean exit. `term` = SIGTERM, `kill` = SIGKILL.
	 */
	killPieces(signal: KillSignal, waitMs?: number): Promise<number[]>;
	/** Open the Pieces **Desktop** app (the re-login UI) via `open -a "Pieces"`. */
	openApp(): Promise<void>;
	restartPieces(mode?: RestartMode): Promise<void>;
}

/**
 * `pgrep -f` matcher for the headless Pieces OS service, anchored on the app
 * bundle's executable path. `pgrep -f` matches the whole command line, so a bare
 * `"Pieces OS"` would also match an editor with a "Pieces OS" file open, a `tail`
 * of its logs, or a stray `grep` — any of which the watchdog could then SIGKILL.
 * Anchoring on the bundle path matches only a process actually launched from
 * inside `Pieces OS.app/Contents/MacOS/` (the real service), regardless of where
 * the app is installed.
 */
export const PIECES_PROCESS_MATCHER = 'Pieces OS.app/Contents/MacOS';

/** Contribution surface: native menu-bar sections (rendered from the menu model). */
export interface MenuApi {
	contribute(provider: () => MenuSection): void;
}

export interface DashboardWidget {
	id: string;
	/** Returns an HTML fragment (server-rendered). */
	render: () => string | Promise<string>;
}

export interface DashboardPage {
	path: string;
	title: string;
	render: () => string | Promise<string>;
	/** Optional React-island id mounted into the rendered page. */
	island?: string;
}

/** Contribution surface: dashboard widgets and pages. */
export interface DashboardApi {
	widget(widget: DashboardWidget): void;
	page(page: DashboardPage): void;
}

export interface CliCommandSpec {
	name: string;
	description?: string;
	action: (args: string[]) => void | Promise<void>;
}

/** Contribution surface: graft subcommands onto `pmon`. */
export interface CliApi {
	command(spec: CliCommandSpec): void;
}

/** Integration handle: shared Pieces OS discovery/health (from `@pieces-dev/core`). */
export interface PiecesApi {
	discoverPort(): Promise<number | null>;
	checkHealth(): Promise<boolean>;
	baseUrl(): string | null;
}
