import { describe, expect, it } from 'vitest';
import { VSCODE_APP } from '../app-registry.js';
import { PiecesClient } from '../client.js';
import { checkInEvent } from '../event-builder.js';
import { discoverPort } from '../port-discovery.js';

// Opt-in only: this suite probes for a live PiecesOS (adding port-discovery
// latency) and posts real data, so it must not run in the default unit/CI path.
// Gate it behind RUN_INTEGRATION. Run with: RUN_INTEGRATION=1 pnpm test
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';

describe.runIf(RUN_INTEGRATION)('integration: PiecesOS', () => {
	it('discovers port, posts event, verifies, deletes', async (ctx) => {
		const port = await discoverPort();
		if (!port) {
			// Mark the test as skipped (not passed) so an offline PiecesOS does not
			// report a false green.
			ctx.skip();
			return;
		}

		const client = new PiecesClient(port);

		const healthy = await client.checkHealth();
		expect(healthy).toBe(true);

		const event = checkInEvent(VSCODE_APP, 'Integration test — safe to delete');
		const eventId = await client.postEvent(event);
		expect(eventId).toBeTruthy();
		if (!eventId) throw new Error('postEvent returned no id');

		const deleted = await client.deleteEvent(eventId);
		expect(deleted).toBe(true);
	});
});
