#!/usr/bin/env node
import { Command } from 'commander';
import { MonitorClient, readToken } from './client.js';
import { renderIncidents, renderStatus, statusExitCode } from './format.js';

const client = () => new MonitorClient(process.env.PMON_URL, readToken());

const unreachable = (): void => {
	console.error('Pieces Monitor daemon is unreachable (is it running? `pmon daemon status`).');
	process.exitCode = 3;
};

const program = new Command();
program.name('pmon').description('Pieces Monitor CLI').version('0.1.0');

program
	.command('status')
	.description('show overall health (exit code reflects ok/warn/crit)')
	.action(async () => {
		try {
			const status = await client().status();
			console.log(renderStatus(status));
			process.exitCode = statusExitCode(status.state);
		} catch {
			unreachable();
		}
	});

program
	.command('incidents')
	.description('list recent incidents')
	.option('-n, --limit <n>', 'max incidents', '50')
	.action(async (opts: { limit: string }) => {
		try {
			console.log(renderIncidents(await client().incidents(Number(opts.limit))));
		} catch {
			unreachable();
		}
	});

program
	.command('logs')
	.description('list recent log entries')
	.option('-n, --limit <n>', 'max entries', '50')
	.action(async (opts: { limit: string }) => {
		try {
			for (const entry of await client().logs(Number(opts.limit))) {
				console.log(
					`${new Date(entry.at).toISOString()} [${entry.level}] ${entry.source}: ${entry.message}`,
				);
			}
		} catch {
			unreachable();
		}
	});

const daemon = program.command('daemon').description('daemon control');
daemon
	.command('status')
	.description('is the daemon running?')
	.action(async () => {
		const up = await client().isUp();
		console.log(up ? 'running' : 'not running');
		process.exitCode = up ? 0 : 1;
	});

program.parseAsync().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
