import type { WorkstreamEventInput } from '@pieces-dev/core';

/**
 * Posts an event to PiecesOS if connected, otherwise enqueues it. Centralised
 * here so every handler shares one send/queue path and always uses the live
 * connection (handlers must not capture a PiecesClient snapshot, which goes
 * stale across reconnects).
 */
export type EmitFn = (event: WorkstreamEventInput, label: string) => void;

export type LogFn = (msg: string) => void;
