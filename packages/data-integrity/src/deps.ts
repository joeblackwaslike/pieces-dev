import type { EventBusApi, HealthApi, IncidentApi, LogApi, NotifyApi } from '@pieces-dev/monitor-sdk';
import type { BaselineStore } from './baseline.js';
import type { FileStat } from './fs.js';
import type { HistoryStore } from './history.js';
import type { DbProbe, ProbeOptions } from './sqlite.js';
import type { DataIntegritySettings } from './settings.js';

/** The injectable seam for {@link DataIntegrityEngine} — all I/O arrives through here. */
export interface DataIntegrityDeps {
	now(): number;
	settings(): DataIntegritySettings;

	// filesystem
	statFile(path: string): FileStat;
	walInfo(path: string): { walBytes: number; shmPresent: boolean };
	expandGlob(dataDir: string, glob: string): string[];

	// sqlite probe
	probe(path: string, opts?: ProbeOptions): DbProbe;

	// capture-gate inputs (freshness only alarms when capture should be happening)
	piecesHealthy(): Promise<boolean>;
	piecesAuthed(): Promise<boolean>;
	idleSeconds(): number;

	// observability
	health: Pick<HealthApi, 'report'>;
	incidents: Pick<IncidentApi, 'record'>;
	notify: Pick<NotifyApi, 'notify'>;
	log: LogApi;
	bus: EventBusApi;

	// persistence
	baseline: BaselineStore;
	history: HistoryStore;
}
