import koffi from "koffi";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RESOURCES_DIR = "/Applications/Pieces OS.app/Contents/Resources";

function findLibcblite(): string {
  if (!existsSync(RESOURCES_DIR)) {
    throw new Error("Pieces OS not installed at /Applications/Pieces OS.app");
  }
  for (const entry of readdirSync(RESOURCES_DIR)) {
    const candidate = join(RESOURCES_DIR, entry, "libcblite.dylib");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("libcblite.dylib not found inside Pieces OS.app bundle");
}

const FLSliceResult = koffi.struct("FLSliceResult", {
  buf: "void *",
  size: "size_t",
});

let lib: ReturnType<typeof koffi.load> | null = null;

let _FLValue_FromData: (buf: unknown, size: number, trust: number) => unknown;
let _FLValue_ToJSON: (value: unknown) => { buf: unknown; size: number };
let _FLValue_AsString: (value: unknown) => { buf: unknown; size: number };
let _FLArray_Count: (value: unknown) => number;
let _FLArray_Get: (value: unknown, index: number) => unknown;

function ensureLoaded() {
  if (lib) return;
  const path = findLibcblite();
  lib = koffi.load(path);

  _FLValue_FromData = lib.func("FLValue_FromData", "void *", [
    "const void *",
    "size_t",
    "int",
  ]);
  _FLValue_ToJSON = lib.func("FLValue_ToJSON", FLSliceResult, ["void *"]);
  _FLValue_AsString = lib.func("FLValue_AsString", FLSliceResult, ["void *"]);
  _FLArray_Count = lib.func("FLArray_Count", "uint32_t", ["void *"]);
  _FLArray_Get = lib.func("FLArray_Get", "void *", ["void *", "uint32_t"]);
}

function readSlice(slice: { buf: unknown; size: number }): string | null {
  if (!slice.buf || slice.size === 0) return null;
  const bytes = koffi.decode(slice.buf, "uint8_t", Number(slice.size));
  return Buffer.from(bytes).toString("utf-8");
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
  if (!rawJson) return null;

  const resolved = rawJson.replace(SHARED_KEY_REGEX, (_match, prefix: string, num: string) => {
    const idx = parseInt(num);
    const name = sharedKeys[idx] ?? num;
    return `${prefix}"${name}":`;
  });

  return JSON.parse(resolved);
}

export function close() {
  lib = null;
}
