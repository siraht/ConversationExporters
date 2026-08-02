import type { JsonObject, JsonValue } from "./types";

export function isJsonObject(value: JsonValue | unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: JsonValue | unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function firstArray(value: JsonValue, paths: readonly (readonly string[])[]): JsonValue[] {
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function firstString(value: JsonValue | undefined, paths: readonly (readonly string[])[]): string | undefined {
  if (value === undefined) return undefined;
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return undefined;
}

export function firstBoolean(value: JsonValue | undefined, paths: readonly (readonly string[])[]): boolean | undefined {
  if (value === undefined) return undefined;
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (typeof candidate === "boolean") return candidate;
  }
  return undefined;
}

export function readPath(value: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isJsonObject(value)) return value;

  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) sorted[key] = sortJson(child);
  }
  return sorted;
}
