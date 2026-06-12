import type { HealthState } from '@pieces-dev/monitor-sdk';
import type { Services } from './runtime.js';

const COLOR: Record<HealthState, string> = { ok: '#2e7d32', warn: '#f9a825', crit: '#c62828' };

function escape(s: string): string {
	return s.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

/** Render the server-side dashboard shell: status banner, widget grid, incident timeline. */
export async function renderShell(services: Services): Promise<string> {
	const status = services.health.overall();
	const widgets = await Promise.all(services.dashboard.widgets.map((w) => w.render()));
	const incidents = services.incidents.forExtension('core').query({ limit: 20 });

	const widgetGrid = widgets.length
		? widgets.map((html) => `<div class="widget">${html}</div>`).join('')
		: '<p class="muted">No widgets yet.</p>';

	const timeline = incidents.length
		? incidents
				.map(
					(i) =>
						`<li><span class="sev sev-${i.severity}">${escape(i.severity)}</span> <strong>${escape(i.kind)}</strong> — ${escape(i.summary)} <span class="muted">(${escape(i.source)})</span></li>`,
				)
				.join('')
		: '<li class="muted">No incidents recorded.</li>';

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pieces Monitor</title>
<style>
	:root { font-family: -apple-system, system-ui, sans-serif; }
	body { margin: 0; background: #f5f5f7; color: #1d1d1f; }
	header { padding: 16px 24px; display: flex; align-items: center; gap: 12px; background: #fff; border-bottom: 1px solid #e0e0e0; }
	.dot { width: 14px; height: 14px; border-radius: 50%; background: ${COLOR[status.state]}; }
	h1 { font-size: 18px; margin: 0; }
	main { padding: 24px; display: grid; gap: 24px; max-width: 960px; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
	.widget, .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 10px; padding: 16px; }
	.muted { color: #86868b; }
	ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
	.sev { font-size: 11px; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; background: #eee; }
	.sev-warn { background: #fff3cd; } .sev-crit { background: #f8d7da; }
</style>
</head>
<body>
<header><span class="dot"></span><h1>Pieces Monitor</h1><span class="muted">status: ${escape(status.state)}</span></header>
<main>
	<section><h2>Widgets</h2><div class="grid">${widgetGrid}</div></section>
	<section class="card"><h2>Incidents</h2><ul>${timeline}</ul></section>
</main>
</body>
</html>`;
}
