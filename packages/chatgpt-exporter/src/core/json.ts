// Adapted from GrokExporter commit 85922d6.
import type { JsonObject, JsonValue } from "./types";

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
