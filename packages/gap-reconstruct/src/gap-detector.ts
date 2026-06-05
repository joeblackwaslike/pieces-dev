import { PiecesClient, discoverPort } from '@pieces-dev/core';

export type Gap = {
  from: Date;
  to: Date;
};

export function findGapsInTimeline(
  events: Array<{ timestamp: Date }>,
  minGapMs: number,
): Gap[] {
  if (events.length < 2) return [];

  const sorted = [...events].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const gaps: Gap[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const diff = curr.timestamp.getTime() - prev.timestamp.getTime();

    if (diff >= minGapMs) {
      gaps.push({ from: prev.timestamp, to: curr.timestamp });
    }
  }

  return gaps;
}

export async function detectGaps(
  since: Date,
  until: Date,
  minGapMs: number,
): Promise<Gap[]> {
  const port = await discoverPort();
  if (!port) {
    console.error('Error: PiecesOS not found. Is it running?');
    return [];
  }

  const client = new PiecesClient(port);
  const healthy = await client.checkHealth();
  if (!healthy) {
    console.error('Error: PiecesOS health check failed');
    return [];
  }

  const rawEvents = await client.getEvents();
  const events = (rawEvents as Array<{ created?: { value?: string } }>)
    .map((e) => {
      const ts = e.created?.value;
      return ts ? { timestamp: new Date(ts) } : null;
    })
    .filter((e): e is { timestamp: Date } => {
      if (!e) return false;
      return e.timestamp >= since && e.timestamp <= until;
    });

  if (events.length === 0) {
    console.log(`No events found in range ${since.toISOString()} → ${until.toISOString()}`);
    console.log('The entire range is a gap.');
    return [{ from: since, to: until }];
  }

  const gaps = findGapsInTimeline(events, minGapMs);

  // Also check for a leading gap (since → first event)
  const firstEvent = events.sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  )[0]!;
  if (firstEvent.timestamp.getTime() - since.getTime() >= minGapMs) {
    gaps.unshift({ from: since, to: firstEvent.timestamp });
  }

  // And a trailing gap (last event → until)
  const lastEvent = events[events.length - 1]!;
  if (until.getTime() - lastEvent.timestamp.getTime() >= minGapMs) {
    gaps.push({ from: lastEvent.timestamp, to: until });
  }

  return gaps.sort((a, b) => a.from.getTime() - b.from.getTime());
}
