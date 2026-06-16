import type { SourceEvent } from '@pieces-dev/core';

export type Source = {
	name: string;
	collect(from: Date, to: Date): AsyncIterable<SourceEvent>;
};
