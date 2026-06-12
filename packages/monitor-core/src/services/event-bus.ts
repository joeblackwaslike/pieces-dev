import type { EventBusApi } from '@pieces-dev/monitor-sdk';

type Handler = (payload: unknown) => void;
type AnyHandler = (event: string, payload: unknown) => void;

/**
 * The event bus: cross-extension pub/sub. Events are named `<emitter-id>.<event>`
 * by convention. `onAny` feeds the WS `/events` live-push bridge.
 */
export class EventBus {
	private readonly handlers = new Map<string, Set<Handler>>();
	private readonly anyHandlers = new Set<AnyHandler>();

	/** The {@link EventBusApi} handed to extensions (shared; events are global). */
	api(): EventBusApi {
		return {
			emit: (event, payload) => this.emit(event, payload),
			on: (event, handler) => this.on(event, handler),
		};
	}

	emit(event: string, payload?: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
		for (const any of this.anyHandlers) any(event, payload);
	}

	on(event: string, handler: Handler): () => void {
		const set = this.handlers.get(event) ?? new Set<Handler>();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}

	onAny(handler: AnyHandler): () => void {
		this.anyHandlers.add(handler);
		return () => this.anyHandlers.delete(handler);
	}
}
