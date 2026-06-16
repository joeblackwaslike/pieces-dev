import type { WorkstreamEventInput } from '@pieces-dev/core';

export class EventQueue {
	private buffer: WorkstreamEventInput[] = [];
	private readonly maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
	}

	get size(): number {
		return this.buffer.length;
	}

	enqueue(event: WorkstreamEventInput): void {
		if (this.buffer.length >= this.maxSize) {
			this.buffer.shift();
		}
		this.buffer.push(event);
	}

	async drain(callback: (event: WorkstreamEventInput) => Promise<void>): Promise<void> {
		// Peek, await, then remove — so an event is not lost if the callback
		// throws mid-drain (it stays at the head of the buffer and the throw
		// propagates out, stopping the drain).
		while (this.buffer.length > 0) {
			const event = this.buffer[0]!;
			await callback(event);
			this.buffer.shift();
		}
	}
}
