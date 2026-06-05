type SeededEvent = {
  application: { id: string; name: string; version: string; platform: string };
  trigger: Record<string, boolean>;
  readable?: string;
  context?: Record<string, unknown>;
};

export class EventQueue {
  private buffer: SeededEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.buffer.length;
  }

  enqueue(event: SeededEvent): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }
    this.buffer.push(event);
  }

  async drain(
    callback: (event: SeededEvent) => Promise<void>,
  ): Promise<void> {
    while (this.buffer.length > 0) {
      const event = this.buffer.shift()!;
      await callback(event);
    }
  }
}
