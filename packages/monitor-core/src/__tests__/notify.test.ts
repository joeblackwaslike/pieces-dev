import { describe, expect, test } from 'vitest';
import type { NotificationInput } from '@pieces-dev/monitor-sdk';
import { Notify } from '../services/notify.js';

function setup(now: () => number) {
	const sent: NotificationInput[] = [];
	const notify = new Notify((n) => sent.push(n), now, 1000);
	return { notify, sent };
}

describe('Notification service', () => {
	test('presents once and suppresses duplicates within the rate-limit window', () => {
		let t = 0;
		const { notify, sent } = setup(() => t);
		const note: NotificationInput = { title: 'A', body: 'b', dedupKey: 'k' };
		notify.api().notify(note);
		t = 500;
		notify.api().notify(note);
		expect(sent).toHaveLength(1);
		t = 1500;
		notify.api().notify(note);
		expect(sent).toHaveLength(2);
	});

	test('different dedup keys present independently', () => {
		const { notify, sent } = setup(() => 0);
		notify.api().notify({ title: 'A', body: 'b', dedupKey: 'k1' });
		notify.api().notify({ title: 'B', body: 'b', dedupKey: 'k2' });
		expect(sent).toHaveLength(2);
	});
});
