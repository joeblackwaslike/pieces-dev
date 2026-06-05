import { describe, expect, it } from 'vitest';
import { discoverPort } from '../port-discovery.js';
import { PiecesClient } from '../client.js';
import { checkInEvent } from '../event-builder.js';
import { VSCODE_APP } from '../app-registry.js';

describe('integration: PiecesOS', () => {
  it('discovers port, posts event, verifies, deletes', async () => {
    const port = await discoverPort();
    if (!port) {
      console.log('PiecesOS not running — skipping integration test');
      return;
    }

    const client = new PiecesClient(port);

    const healthy = await client.checkHealth();
    expect(healthy).toBe(true);

    const event = checkInEvent(VSCODE_APP, 'Integration test — safe to delete');
    const eventId = await client.postEvent(event);
    expect(eventId).toBeTruthy();

    const deleted = await client.deleteEvent(eventId!);
    expect(deleted).toBe(true);
  });
});
