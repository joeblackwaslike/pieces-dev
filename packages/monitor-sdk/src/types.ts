/**
 * Shared value types for the Pieces Monitor extension contract.
 *
 * These are the data shapes that flow between the daemon, its services, the
 * extensions, and the three frontends (menu bar / dashboard / CLI).
 */

/** Health rollup state. Worst-of wins when aggregated. */
export type HealthState = 'ok' | 'warn' | 'crit';

/** Severity for incidents and notifications. */
export type Severity = 'info' | 'warn' | 'crit';

/** A single health check's current status, as reported by an extension. */
export interface HealthReport {
	/** Namespaced check id, e.g. `metrics.cpu` or `data.couchbase`. */
	checkId: string;
	state: HealthState;
	detail?: string;
	/** Epoch ms the report was made. */
	at: number;
}

/** Overall rollup across every registered check. */
export interface OverallStatus {
	state: HealthState;
	checks: HealthReport[];
	at: number;
}

/** What an extension passes to `incidents.record`. */
export interface IncidentInput {
	/** Stable kind, e.g. `restart`, `size-collapse`, `backup-failed`. */
	kind: string;
	severity: Severity;
	summary: string;
	/** Arbitrary structured payload for the dashboard / doctor page. */
	data?: unknown;
}

/** A persisted incident (input + fields stamped by core). */
export interface Incident extends IncidentInput {
	id: string;
	/** Extension that recorded it (or `core`). */
	source: string;
	/** Epoch ms. */
	at: number;
}

export interface IncidentQuery {
	source?: string;
	kind?: string;
	since?: number;
	limit?: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
	level: LogLevel;
	source: string;
	message: string;
	data?: unknown;
	at: number;
}

export interface LogQuery {
	source?: string;
	level?: LogLevel;
	since?: number;
	limit?: number;
}

/** A notification request. Core dedups + rate-limits before presenting. */
export interface NotificationInput {
	title: string;
	body: string;
	severity?: Severity;
	/** Optional dedup key; repeats within the rate-limit window are suppressed. */
	dedupKey?: string;
	/** Action fired when the user clicks the notification. */
	action?: MenuAction;
}

/** A typed menu action, shared by menu items, notifications, and dashboard buttons. */
export type MenuAction =
	| { type: 'open-url'; url: string }
	| { type: 'run-command'; commandId: string; params?: Record<string, unknown> }
	| { type: 'deep-link'; route: string };

export interface MenuItem {
	label: string;
	action?: MenuAction;
	enabled?: boolean;
	/** Transient display state for command feedback in the menu bar. */
	state?: 'idle' | 'running' | 'ok' | 'error';
	children?: MenuItem[];
}

export interface MenuSection {
	title?: string;
	items: MenuItem[];
}

/** The JSON menu model the daemon exposes at `GET /menu` for the Swift app to render. */
export interface MenuModel {
	status: HealthState;
	sections: MenuSection[];
	at: number;
}

/**
 * A field in an extension's settings schema. Expressive enough to drive native
 * SwiftUI control generation as well as the web dashboard and CLI.
 */
export interface SettingsField {
	key: string;
	label: string;
	help?: string;
	type: 'bool' | 'number' | 'string' | 'enum' | 'path';
	default: unknown;
	/** number constraints */
	min?: number;
	max?: number;
	step?: number;
	/** enum options */
	options?: Array<{ label: string; value: string }>;
}

export interface SettingsSection {
	id: string;
	title: string;
	/** Render this section as a custom web pane (WKWebView) instead of native controls. */
	web?: boolean;
	fields: SettingsField[];
}

export interface SettingsSchema {
	sections: SettingsSection[];
}

/** A named, invokable command — the same verb across menu bar, dashboard, CLI, and API. */
export interface Command {
	id: string;
	title: string;
	/** Parameter schema, if the command takes arguments. */
	params?: SettingsField[];
	/** Drives menu-bar feedback: fast → inline state; long-running → notifications. */
	expectedDurationMs?: number;
	/** Marks a long-running command whose completion outlives the menu. */
	async?: boolean;
	/** Requires the uniform confirmation flow across every surface. */
	destructive?: boolean;
	handler: (params?: Record<string, unknown>) => unknown | Promise<unknown>;
}
