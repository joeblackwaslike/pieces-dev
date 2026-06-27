import type {
	EventBusApi,
	HealthApi,
	IncidentApi,
	LogApi,
	NotifyApi,
	PiecesApi,
	ProcessApi,
} from '@pieces-dev/monitor-sdk';
import type { HttpGet, HttpPost } from './http.js';
import type { WatchdogSettings } from './settings.js';
import type { StatePersistence } from './state.js';

/** Process operations the watchdog drives — a narrowed view of {@link ProcessApi}. */
export type WatchdogProcess = Pick<
	ProcessApi,
	'listPids' | 'launchPieces' | 'killPieces' | 'openApp'
>;

/** Pieces integration the watchdog reads — discovery base URL + health probe. */
export type WatchdogPieces = Pick<PiecesApi, 'baseUrl' | 'checkHealth'>;

export interface RearmHandle {
	cancel(): void;
}

/**
 * The injectable seam. Everything the {@link WatchdogEngine} touches arrives
 * through this interface, so the FSM never imports a `HostContext` and every
 * branch is a deterministic unit test (injected clock, sleep, and spies).
 */
export interface WatchdogDeps {
	/** Epoch ms. */
	now(): number;
	sleep(ms: number): Promise<void>;
	process: WatchdogProcess;
	pieces: WatchdogPieces;
	httpGet: HttpGet;
	httpPost: HttpPost;
	health: Pick<HealthApi, 'report'>;
	incidents: Pick<IncidentApi, 'record'>;
	notify: Pick<NotifyApi, 'notify'>;
	log: LogApi;
	bus: EventBusApi;
	/** A fresh settings snapshot (re-read every tick for live reload). */
	settings(): WatchdogSettings;
	persist: StatePersistence;
	/** Schedule a single delayed callback (the post-give-up auto-rearm). */
	scheduleRearm(delayMs: number, fn: () => void): RearmHandle;
}
