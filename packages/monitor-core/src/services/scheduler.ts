import type { ScheduleHandle, SchedulerApi, ScheduleSpec } from '@pieces-dev/monitor-sdk';

type ErrorHandler = (error: unknown) => void;
type Task = () => void | Promise<void>;

/**
 * The scheduler: one shared interval engine so extensions don't each spin their
 * own loops. Handler errors are reported (not swallowed) and never stop the
 * recurring task. Cron specs are reserved for a later cycle.
 */
export class Scheduler {
	private readonly handles = new Set<ScheduleHandle>();
	private readonly onError: ErrorHandler;

	constructor(onError: ErrorHandler = (error) => console.error('[scheduler]', error)) {
		this.onError = onError;
	}

	api(): SchedulerApi {
		return {
			schedule: (spec, handler) => this.schedule(spec, handler),
		};
	}

	private schedule(spec: ScheduleSpec, handler: Task): ScheduleHandle {
		if (!('everyMs' in spec)) {
			throw new Error('cron scheduling is not yet supported');
		}
		const timer = setInterval(() => this.run(handler), spec.everyMs);
		const handle: ScheduleHandle = {
			cancel: () => {
				clearInterval(timer);
				this.handles.delete(handle);
			},
		};
		this.handles.add(handle);
		return handle;
	}

	private run(handler: Task): void {
		try {
			const result = handler();
			if (result && typeof (result as Promise<void>).then === 'function') {
				(result as Promise<void>).catch(this.onError);
			}
		} catch (error) {
			this.onError(error);
		}
	}

	/** Cancel every scheduled task (daemon shutdown). */
	stopAll(): void {
		for (const handle of [...this.handles]) handle.cancel();
	}
}
