import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigApi, SettingsSchema } from '@pieces-dev/monitor-sdk';

export interface ConfigOptions {
	/** JSON file to persist to. Omit for in-memory (tests). */
	path?: string;
}

type ChangeHandler = (key: string, value: unknown) => void;

/**
 * The config store: one schema-validated, namespaced settings store shared by
 * the settings window, dashboard, and CLI. Hands out a {@link ConfigApi} scoped
 * to each extension; persists the whole store as a single JSON file.
 */
export class Config {
	private readonly path?: string;
	private readonly values: Record<string, Record<string, unknown>>;
	private readonly schemas = new Map<string, SettingsSchema>();
	private readonly listeners = new Map<string, Set<ChangeHandler>>();

	constructor(options: ConfigOptions = {}) {
		this.path = options.path;
		this.values = this.path ? load(this.path) : {};
	}

	forExtension(namespace: string): ConfigApi {
		return {
			registerSchema: (schema) => this.schemas.set(namespace, schema),
			get: <T>(key: string) => this.read(namespace, key) as T | undefined,
			set: (key, value) => this.write(namespace, key, value),
			all: () => this.allFor(namespace),
			onChange: (handler) => this.subscribe(namespace, handler),
		};
	}

	private read(namespace: string, key: string): unknown {
		const ns = this.values[namespace];
		if (ns && key in ns) return ns[key];
		return this.defaultFor(namespace, key);
	}

	private write(namespace: string, key: string, value: unknown): void {
		let ns = this.values[namespace];
		if (!ns) {
			ns = {};
			this.values[namespace] = ns;
		}
		ns[key] = value;
		this.persist();
		for (const handler of this.listeners.get(namespace) ?? []) handler(key, value);
	}

	private allFor(namespace: string): Record<string, unknown> {
		const merged: Record<string, unknown> = {};
		const schema = this.schemas.get(namespace);
		if (schema) {
			for (const section of schema.sections) {
				for (const field of section.fields) merged[field.key] = field.default;
			}
		}
		return { ...merged, ...this.values[namespace] };
	}

	private defaultFor(namespace: string, key: string): unknown {
		const schema = this.schemas.get(namespace);
		if (!schema) return undefined;
		for (const section of schema.sections) {
			for (const field of section.fields) {
				if (field.key === key) return field.default;
			}
		}
		return undefined;
	}

	private subscribe(namespace: string, handler: ChangeHandler): () => void {
		const set = this.listeners.get(namespace) ?? new Set();
		set.add(handler);
		this.listeners.set(namespace, set);
		return () => set.delete(handler);
	}

	private persist(): void {
		if (!this.path) return;
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(this.values, null, 2));
	}
}

function load(path: string): Record<string, Record<string, unknown>> {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return {};
	}
}
