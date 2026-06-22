import { discoverPort, PiecesClient, type SourceEvent } from '@pieces-dev/core';
import { ArcHistorySource } from './sources/arc-history.js';
import { ClaudeCodeSource } from './sources/claude-code.js';
import { GitLogSource } from './sources/git-log.js';
import { ScreenTimeSource } from './sources/screen-time.js';
import type { Source } from './sources/types.js';

export type PipelineOptions = {
	from: Date;
	to: Date;
	sources: string[];
	dryRun: boolean;
	limit?: number;
	concurrency: number;
	skipSummaries: boolean;
	repos?: string[];
	/** Override PiecesOS port discovery (e.g. non-standard installs). */
	port?: number;
};

const MAX_CONCURRENCY = 32;

const SOURCE_PRIORITY: Record<string, number> = {
	claude: 0,
	screentime: 1,
	git: 2,
	arc: 3,
};

export function dedup(events: SourceEvent[]): SourceEvent[] {
	const seen = new Map<string, SourceEvent>();

	for (const evt of events) {
		const existing = seen.get(evt.dedupKey);
		if (!existing) {
			seen.set(evt.dedupKey, evt);
			continue;
		}

		const existingPriority = SOURCE_PRIORITY[existing.source] ?? 99;
		const newPriority = SOURCE_PRIORITY[evt.source] ?? 99;
		if (newPriority < existingPriority) {
			seen.set(evt.dedupKey, evt);
		}
	}

	return [...seen.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function createSources(sourceNames: string[], repos?: string[]): Source[] {
	const sources: Source[] = [];

	for (const name of sourceNames) {
		switch (name) {
			case 'claude':
				sources.push(new ClaudeCodeSource());
				break;
			case 'screentime':
				sources.push(new ScreenTimeSource());
				break;
			case 'arc':
				sources.push(new ArcHistorySource());
				break;
			case 'git':
				sources.push(new GitLogSource(repos ?? []));
				break;
			default:
				console.warn(`Unknown source: ${name} — skipping`);
		}
	}

	return sources;
}

async function collectAll(sources: Source[], from: Date, to: Date): Promise<SourceEvent[]> {
	const allEvents: SourceEvent[] = [];

	for (const source of sources) {
		let count = 0;
		for await (const evt of source.collect(from, to)) {
			allEvents.push(evt);
			count++;
		}
		console.log(`  ${source.name}: ${count} events`);
	}

	return allEvents;
}

function printDryRun(events: SourceEvent[], from: Date, to: Date): void {
	const durationMs = to.getTime() - from.getTime();
	const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
	const hours = Math.floor((durationMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

	console.log(`\nGap window: ${from.toISOString()} → ${to.toISOString()} (${days}d ${hours}h)`);
	console.log(`\nTotal events after dedup: ${events.length}`);

	const bySource: Record<string, number> = {};
	for (const evt of events) {
		bySource[evt.source] = (bySource[evt.source] ?? 0) + 1;
	}
	console.log('\nBy source:');
	for (const [source, count] of Object.entries(bySource)) {
		console.log(`  ${source}: ${count}`);
	}

	const byDay: Record<string, number> = {};
	for (const evt of events) {
		const day = evt.timestamp.toISOString().slice(0, 10);
		byDay[day] = (byDay[day] ?? 0) + 1;
	}
	console.log('\nDaily distribution:');
	for (const [day, count] of Object.entries(byDay).sort()) {
		console.log(`  ${day}: ${count} events`);
	}
}

async function injectEvents(
	client: PiecesClient,
	events: SourceEvent[],
	concurrency: number,
): Promise<{ injected: number; failed: number }> {
	let injected = 0;
	let failed = 0;
	let idx = 0;

	// Guard against concurrency <= 0, which would spawn zero workers and
	// silently inject nothing while the caller assumes success.
	const requested = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
	// Cap workers: never more than there are events, and never above a sane
	// ceiling so a huge --concurrency can't allocate a giant pool or flood
	// PiecesOS.
	const workerCount = Math.min(requested, MAX_CONCURRENCY, Math.max(1, events.length));
	if (workerCount !== concurrency) {
		console.warn(`Adjusted concurrency ${concurrency} → ${workerCount}`);
	}

	async function worker(): Promise<void> {
		while (idx < events.length) {
			const current = idx++;
			const evt = events[current]!;
			try {
				const id = await client.postEvent(evt.event as Record<string, unknown>);
				if (id) {
					injected++;
				} else {
					failed++;
				}
			} catch (err) {
				// A single failed request must not abort the whole backfill run.
				failed++;
				console.warn(`Failed to inject event (${evt.source}/${evt.dedupKey}):`, err);
			}
			if ((injected + failed) % 100 === 0) {
				console.log(`  Progress: ${injected + failed}/${events.length} (${failed} failed)`);
			}
		}
	}

	const workers = Array.from({ length: workerCount }, () => worker());
	await Promise.all(workers);

	return { injected, failed };
}

async function generateSummaries(client: PiecesClient, events: SourceEvent[]): Promise<void> {
	const days = new Set(events.map((e) => e.timestamp.toISOString().slice(0, 10)));

	console.log(`\nGenerating summaries for ${days.size} days...`);

	for (const day of [...days].sort()) {
		const from = new Date(`${day}T00:00:00Z`);
		const to = new Date(`${day}T23:59:59Z`);
		const ok = await client.triggerSummary(from, to);
		console.log(`  ${day}: ${ok ? 'OK' : 'FAILED'}`);
	}
}

export async function runPipeline(options: PipelineOptions): Promise<void> {
	console.log('Collecting events...');

	const sources = createSources(options.sources, options.repos);
	const rawEvents = await collectAll(sources, options.from, options.to);
	const events = dedup(rawEvents);

	if (options.limit !== undefined) {
		// Fail fast: this is a write pipeline, so an invalid --limit must not
		// silently fall through to injecting everything.
		if (!Number.isInteger(options.limit) || options.limit < 0) {
			console.error(`Error: --limit must be a non-negative integer (got ${options.limit})`);
			process.exit(1);
		}
		if (events.length > options.limit) {
			events.length = options.limit;
			console.log(`\nLimited to ${options.limit} events`);
		}
	}

	if (options.dryRun) {
		printDryRun(events, options.from, options.to);
		return;
	}

	const port = await discoverPort(options.port ? { portOverride: options.port } : undefined);
	if (!port) {
		console.error('Error: PiecesOS not found. Is it running?');
		process.exit(1);
	}

	const client = new PiecesClient(port);
	const healthy = await client.checkHealth();
	if (!healthy) {
		console.error('Error: PiecesOS health check failed');
		process.exit(1);
	}

	console.log(`\nInjecting ${events.length} events into PiecesOS on port ${port}...`);
	const { injected, failed } = await injectEvents(client, events, options.concurrency);

	console.log(`\nDone: ${injected} injected, ${failed} failed`);

	if (!options.skipSummaries && injected > 0) {
		await generateSummaries(client, events);
	}
}
