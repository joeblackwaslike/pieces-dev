import type { SqlParam, StoreApi } from '@pieces-dev/monitor-sdk';

/**
 * The slice of watchdog state that must survive a daemon restart, so a
 * crash-looping Pieces isn't gifted a fresh restart budget on every daemon
 * bounce and an auth-lost notification isn't re-fired after a restart.
 */
export interface PersistedState {
	restartCount: number;
	lastCleanTime: number;
	gaveUp: boolean;
	gaveUpAt: number;
	authLoggedIn: boolean;
}

export interface StatePersistence {
	load(): PersistedState;
	save(patch: Partial<PersistedState>): void;
}

interface StateRow {
	restart_count: number;
	last_clean_time: number;
	gave_up: number;
	gave_up_at: number;
	auth_logged_in: number;
}

const COLUMNS: Record<keyof PersistedState, string> = {
	restartCount: 'restart_count',
	lastCleanTime: 'last_clean_time',
	gaveUp: 'gave_up',
	gaveUpAt: 'gave_up_at',
	authLoggedIn: 'auth_logged_in',
};

const DEFAULTS: PersistedState = {
	restartCount: 0,
	lastCleanTime: 0,
	gaveUp: false,
	gaveUpAt: 0,
	authLoggedIn: true,
};

/** Wire up the single-row state table and return a typed load/save handle. */
export function createStatePersistence(store: StoreApi): StatePersistence {
	store.migrate(1, [
		`CREATE TABLE watchdog_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			restart_count INTEGER NOT NULL DEFAULT 0,
			last_clean_time INTEGER NOT NULL DEFAULT 0,
			gave_up INTEGER NOT NULL DEFAULT 0,
			gave_up_at INTEGER NOT NULL DEFAULT 0,
			auth_logged_in INTEGER NOT NULL DEFAULT 1
		)`,
		`INSERT INTO watchdog_state (id) VALUES (1)`,
	]);

	return {
		load() {
			const row = store.get<StateRow>('SELECT * FROM watchdog_state WHERE id = 1');
			if (!row) return { ...DEFAULTS };
			return {
				restartCount: row.restart_count,
				lastCleanTime: row.last_clean_time,
				gaveUp: row.gave_up !== 0,
				gaveUpAt: row.gave_up_at,
				authLoggedIn: row.auth_logged_in !== 0,
			};
		},
		save(patch) {
			const keys = Object.keys(patch) as Array<keyof PersistedState>;
			if (keys.length === 0) return;
			const assignments = keys.map((key) => `${COLUMNS[key]} = ?`).join(', ');
			const params = keys.map((key): SqlParam => {
				const value = patch[key];
				return typeof value === 'boolean' ? (value ? 1 : 0) : (value as number);
			});
			store.run(`UPDATE watchdog_state SET ${assignments} WHERE id = 1`, ...params);
		},
	};
}
