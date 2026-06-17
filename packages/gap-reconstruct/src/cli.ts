#!/usr/bin/env node
import { Command } from 'commander';
import { detectGaps } from './gap-detector.js';
import { runPipeline } from './pipeline.js';

const program = new Command();

program
	.name('gap-reconstruct')
	.description('Detect and backfill PiecesOS LTM gaps from multiple data sources')
	.version('0.1.0');

program
	.command('detect')
	.description('Scan PiecesOS events to find gaps in LTM coverage')
	.option('--min-gap <minutes>', 'Minimum gap duration to report (minutes)', Number.parseInt, 60)
	.option('--since <iso>', 'How far back to scan (ISO 8601 or relative like "30d")')
	.action(async (opts) => {
		const minGapMs = (opts.minGap as number) * 60 * 1000;
		const since = opts.since
			? parseSince(opts.since as string)
			: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const gaps = await detectGaps(since, new Date(), minGapMs);

		if (gaps.length === 0) {
			console.log('No gaps found.');
			return;
		}

		console.log(`Found ${gaps.length} gap(s):\n`);
		for (const gap of gaps) {
			const durationH =
				Math.round(((gap.to.getTime() - gap.from.getTime()) / (1000 * 60 * 60)) * 10) / 10;
			console.log(`  ${gap.from.toISOString()} → ${gap.to.toISOString()}  (${durationH}h)`);
		}

		console.log(`\nTo backfill a specific gap:`);
		console.log(`  gap-reconstruct run --from <start> --to <end>`);
		console.log(`\nTo backfill all gaps:`);
		console.log(`  gap-reconstruct run --all-gaps --since ${since.toISOString()}`);
	});

program
	.command('run')
	.description('Backfill a gap period with events from data sources')
	.option('--from <iso>', 'Gap start (ISO 8601)')
	.option('--to <iso>', 'Gap end (ISO 8601)')
	.option('--all-gaps', 'Detect and backfill all gaps', false)
	.option('--since <iso>', 'How far back to scan for --all-gaps (ISO 8601 or relative)', '30d')
	.option(
		'--min-gap <minutes>',
		'Minimum gap duration for --all-gaps (minutes)',
		Number.parseInt,
		60,
	)
	.option(
		'--sources <list>',
		'Comma-separated sources: claude,screentime,arc,git',
		'claude,screentime,arc,git',
	)
	.option('--dry-run', 'Collect and display events without injecting', false)
	.option('--limit <n>', 'Inject only first N events per gap', Number.parseInt)
	.option('--concurrency <n>', 'Parallel injection requests', Number.parseInt, 5)
	.option('--skip-summaries', 'Skip summary generation after injection', false)
	.option('--repos <paths>', 'Comma-separated repo paths for git source')
	.option('--port <n>', 'Override PiecesOS port (skip auto-discovery)', Number.parseInt)
	.action(async (opts) => {
		const sources = (opts.sources as string).split(',').filter(Boolean);
		const repos = opts.repos ? (opts.repos as string).split(',') : undefined;
		const baseOpts = {
			sources,
			dryRun: opts.dryRun as boolean,
			limit: opts.limit as number | undefined,
			concurrency: opts.concurrency as number,
			skipSummaries: opts.skipSummaries as boolean,
			repos,
			port: opts.port as number | undefined,
		};

		if (opts.allGaps) {
			const since = parseSince(opts.since as string);
			const minGapMs = (opts.minGap as number) * 60 * 1000;
			const gaps = await detectGaps(since, new Date(), minGapMs);

			if (gaps.length === 0) {
				console.log('No gaps found — nothing to backfill.');
				return;
			}

			console.log(`Found ${gaps.length} gap(s) to backfill:\n`);
			for (let i = 0; i < gaps.length; i++) {
				const gap = gaps[i]!;
				console.log(
					`\n=== Gap ${i + 1}/${gaps.length}: ${gap.from.toISOString()} → ${gap.to.toISOString()} ===\n`,
				);
				await runPipeline({ ...baseOpts, from: gap.from, to: gap.to });
			}
			return;
		}

		if (!opts.from || !opts.to) {
			console.error('Error: --from and --to are required (or use --all-gaps)');
			process.exit(1);
		}

		const from = new Date(opts.from as string);
		const to = new Date(opts.to as string);

		if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
			console.error('Error: --from and --to must be valid ISO 8601 dates');
			process.exit(1);
		}

		await runPipeline({ ...baseOpts, from, to });
	});

function parseSince(value: string): Date {
	const match = value.match(/^(\d+)d$/);
	if (match) {
		return new Date(Date.now() - Number.parseInt(match[1]!, 10) * 24 * 60 * 60 * 1000);
	}
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) {
		console.error(`Error: invalid date/duration: ${value}`);
		process.exit(1);
	}
	return d;
}

program.parse();
