import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

const RESOURCES_DIR = '/Applications/Pieces OS.app/Contents/Resources';

function findLibcblite(): string {
	if (!existsSync(RESOURCES_DIR)) {
		throw new Error('Pieces OS not installed at /Applications/Pieces OS.app');
	}
	for (const entry of readdirSync(RESOURCES_DIR)) {
		const candidate = join(RESOURCES_DIR, entry, 'libcblite.dylib');
		if (existsSync(candidate)) return candidate;
	}
	throw new Error('libcblite.dylib not found inside Pieces OS.app bundle');
}

const FLSliceResult = koffi.struct('FLSliceResult', {
	buf: 'void *',
	size: 'size_t',
});

let lib: ReturnType<typeof koffi.load> | null = null;

let _FLValue_FromData: (buf: unknown, size: number, trust: number) => unknown;
let _FLValue_ToJSON: (value: unknown) => { buf: unknown; size: number };
let _FLValue_AsString: (value: unknown) => { buf: unknown; size: number };
let _FLArray_Count: (value: unknown) => number;
let _FLArray_Get: (value: unknown, index: number) => unknown;
// FLSliceResult_Release is a static-inline in the Fleece header; the underlying
// exported symbol is _FLBuf_Release(buf). Bound defensively below.
let _FLBuf_Release: ((buf: unknown) => void) | null = null;

function ensureLoaded() {
	if (lib) return;
	const path = findLibcblite();
	lib = koffi.load(path);

	_FLValue_FromData = lib.func('FLValue_FromData', 'void *', ['const void *', 'size_t', 'int']);
	_FLValue_ToJSON = lib.func('FLValue_ToJSON', FLSliceResult, ['void *']);
	_FLValue_AsString = lib.func('FLValue_AsString', FLSliceResult, ['void *']);
	_FLArray_Count = lib.func('FLArray_Count', 'uint32_t', ['void *']);
	_FLArray_Get = lib.func('FLArray_Get', 'void *', ['void *', 'uint32_t']);
	// FLValue_ToJSON returns a heap-allocated FLSliceResult the caller must free
	// via _FLBuf_Release(buf). Some libcblite builds don't export it — bind
	// defensively and accept the small leak rather than crash the decoder.
	try {
		_FLBuf_Release = lib.func('_FLBuf_Release', 'void', ['void *']);
	} catch {
		_FLBuf_Release = null;
	}
}

function readSlice(slice: { buf: unknown; size: number }): string | null {
	if (!slice.buf || slice.size === 0) return null;
	const bytes = koffi.decode(slice.buf, 'uint8_t', Number(slice.size));
	return Buffer.from(bytes).toString('utf-8');
}

export function parseFleeceArray(blob: Buffer): string[] {
	ensureLoaded();
	const root = _FLValue_FromData(blob, blob.length, 1);
	if (!root) return [];
	const count = _FLArray_Count(root);
	const result: string[] = [];
	for (let i = 0; i < count; i++) {
		const elem = _FLArray_Get(root, i);
		if (!elem) {
			result.push(String(i));
			continue;
		}
		const str = readSlice(_FLValue_AsString(elem));
		result.push(str ?? String(i));
	}
	return result;
}

const SHARED_KEY_REGEX = /([{,])(\d+):/g;

export function decodeFleeceToJSON(blob: Buffer, sharedKeys: string[]): unknown {
	ensureLoaded();

	const value = _FLValue_FromData(blob, blob.length, 1);
	if (!value) return null;

	const result = _FLValue_ToJSON(value);
	const rawJson = readSlice(result);
	// readSlice copies the bytes out, so the FLSliceResult can be freed now.
	if (_FLBuf_Release && result.buf) _FLBuf_Release(result.buf);
	if (!rawJson) return null;

	const resolved = rawJson.replace(SHARED_KEY_REGEX, (_match, prefix: string, num: string) => {
		const idx = parseInt(num, 10);
		const name = sharedKeys[idx] ?? num;
		return `${prefix}"${name}":`;
	});

	return JSON.parse(resolved);
}

export function close() {
	lib = null;
}
