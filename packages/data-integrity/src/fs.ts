import { globSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface FileStat {
	exists: boolean;
	bytes: number;
}

/** Size of a file, or `{ exists: false }` if it is gone — never throws. */
export function statFile(path: string): FileStat {
	try {
		return { exists: true, bytes: statSync(path).size };
	} catch {
		return { exists: false, bytes: 0 };
	}
}

/** Sizes of the `-wal` / `-shm` siblings of a SQLite database. */
export function walInfo(path: string): { walBytes: number; shmPresent: boolean } {
	return {
		walBytes: statFile(`${path}-wal`).bytes,
		shmPresent: statFile(`${path}-shm`).exists,
	};
}

/** Expand a glob relative to `dataDir` into sorted absolute paths. */
export function expandGlob(dataDir: string, glob: string): string[] {
	const matches = globSync(glob, { cwd: dataDir }) as string[];
	return matches.map((m) => (isAbsolute(m) ? m : join(dataDir, m))).sort();
}
