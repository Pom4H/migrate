import type { JsonObject, JsonValue } from "./types.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function toJsonValue(value: unknown, path = "value"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item, index) => toJsonValue(item, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      result[key] = toJsonValue(item, `${path}.${key}`);
    }
    return result;
  }
  throw new TypeError(`${path} is not JSON-compatible`);
}

export function toJsonObject(value: unknown, path = "value"): JsonObject {
  const json = toJsonValue(value, path);
  if (json === null || Array.isArray(json) || typeof json !== "object") {
    throw new TypeError(`${path} must be an object`);
  }
  return json;
}

export function stableValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]!);
    return result;
  }
  return value;
}

export function stableStringify(value: JsonValue, space = 2): string {
  return `${JSON.stringify(stableValue(value), null, space)}\n`;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function deepClone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function normalizePathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash === "/") return withLeadingSlash;
  return withLeadingSlash.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

export async function mapLimit<T, TResult>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Concurrency must be at least 1");
  const results = new Array<TResult>(values.length);
  let cursor = 0;

  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function timestampId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function safeFileName(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "item";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
