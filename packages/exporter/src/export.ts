#!/usr/bin/env node
import { createGzip } from "node:zlib";
import { createWriteStream, mkdirSync } from "node:fs";
import { readdir, stat, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

const PIECES_PORT = 1000;
const BASE_URL = `http://localhost:${PIECES_PORT}`;
const BACKUP_ROOT = join(homedir(), "Library/com.pieces.pfd/backups");
const VECTOR_DB_DIR = join(homedir(), "Library/com.pieces.os/production/Pieces/vector_db");
const COUCHBASE_DIR = join(homedir(), "Library/com.pieces.os/production/Pieces/couchbase.cblite2");

// Databases to vacuum-copy — VACUUM INTO creates a clean, compact copy even on live DBs
const SQLITE_DBS = [
  join(VECTOR_DB_DIR, "workstreamEvents.sqlite"),
  join(VECTOR_DB_DIR, "workstreamEvents.archive.sqlite"),
  join(VECTOR_DB_DIR, "workstreamSummaries.sqlite"),
  join(VECTOR_DB_DIR, "workstreamSummaries.archive.sqlite"),
  join(VECTOR_DB_DIR, "hints.sqlite"),
  join(VECTOR_DB_DIR, "hints.archive.sqlite"),
  join(VECTOR_DB_DIR, "conversationMemories.sqlite"),
  join(VECTOR_DB_DIR, "tags.sqlite"),
];

// Couchbase Lite uses a custom SQLite format — VACUUM INTO fails; use direct copy instead
const DIRECT_COPY_DBS = [join(COUCHBASE_DIR, "db.sqlite3")];

function log(msg: string) {
  process.stdout.write(`[pieces-export] ${msg}\n`);
}

function err(msg: string) {
  process.stderr.write(`[pieces-export] ERROR: ${msg}\n`);
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/.well-known/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function apiExport(outDir: string): Promise<Record<string, number>> {
  log("Fetching /database/export from Pieces OS...");
  const res = await fetch(`${BASE_URL}/database/export`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`/database/export returned ${res.status}`);

  const outPath = join(outDir, "database-export.json.gz");
  log(`Streaming export → ${outPath}`);

  const gz = createGzip({ level: 6 });
  const out = createWriteStream(outPath);
  await pipeline(Readable.fromWeb(res.body as never), gz, out);

  // Re-read to extract counts for manifest
  let counts: Record<string, number> = {};
  try {
    const { createReadStream } = await import("node:fs");
    const { createGunzip } = await import("node:zlib");
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      createReadStream(outPath)
        .pipe(createGunzip())
        .on("data", (c: Buffer) => chunks.push(c))
        .on("end", resolve)
        .on("error", reject);
    });
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, { iterable?: unknown[] }>;
    for (const [key, val] of Object.entries(data)) {
      if (val && typeof val === "object" && Array.isArray(val.iterable)) {
        counts[key] = val.iterable.length;
      }
    }
  } catch {
    counts = { note: -1 };
  }
  return counts;
}

function vacuumDb(src: string, dest: string): boolean {
  // VACUUM INTO fails if destination exists — remove it first
  spawnSync("rm", ["-f", dest]);
  const result = spawnSync("sqlite3", [src, `VACUUM INTO '${dest}'`], { timeout: 120_000 });
  return result.status === 0;
}

async function sqliteExport(outDir: string): Promise<Record<string, number>> {
  const sqliteDir = join(outDir, "sqlite");
  mkdirSync(sqliteDir, { recursive: true });
  const counts: Record<string, number> = {};

  for (const src of SQLITE_DBS) {
    const name = src.split("/").pop()!;
    const dest = join(sqliteDir, name);
    const ok = vacuumDb(src, dest);
    if (ok) {
      const { size } = await stat(dest);
      counts[name] = size;
      log(`  ✓ ${name} (${(size / 1_048_576).toFixed(1)} MB)`);
    } else {
      err(`  ✗ VACUUM INTO failed for ${name}`);
    }
  }

  // Direct copy for Couchbase Lite (custom SQLite format, VACUUM INTO incompatible)
  const { copyFile } = await import("node:fs/promises");
  for (const src of DIRECT_COPY_DBS) {
    const name = src.split("/").pop()!;
    const dest = join(sqliteDir, name);
    try {
      await copyFile(src, dest);
      const { size } = await stat(dest);
      counts[name] = size;
      log(`  ✓ ${name} (${(size / 1_048_576).toFixed(1)} MB) [direct copy]`);
    } catch (e) {
      err(`  ✗ direct copy failed for ${name}: ${String(e)}`);
    }
  }

  return counts;
}

async function pruneBackups(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(BACKUP_ROOT);
  } catch {
    return;
  }

  // Keep: last 3 + anything within the past 12 months
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1_000;
  const dated = entries
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort()
    .reverse();

  for (let i = 0; i < dated.length; i++) {
    const entry = dated[i]!;
    const entryMs = new Date(entry).getTime();
    const keep = i < 3 || entryMs >= cutoff;
    if (!keep) {
      log(`Pruning old backup: ${entry}`);
      await rm(join(BACKUP_ROOT, entry), { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const outDir = join(BACKUP_ROOT, today);
  mkdirSync(outDir, { recursive: true });

  log(`Backup dir: ${outDir}`);

  const alive = await checkHealth();
  let strategy: "api" | "sqlite";
  let counts: Record<string, number>;

  if (alive) {
    log("Pieces OS is running — using API export.");
    strategy = "api";
    counts = await apiExport(outDir);
  } else {
    log("Pieces OS is not running — falling back to SQLite VACUUM copies.");
    strategy = "sqlite";
    counts = await sqliteExport(outDir);
  }

  const manifest = {
    timestamp: new Date().toISOString(),
    strategy,
    counts,
  };

  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`Manifest written. Strategy: ${strategy}`);

  await pruneBackups();
  log("Done.");
}

main().catch((e: unknown) => {
  err(String(e));
  process.exit(1);
});
