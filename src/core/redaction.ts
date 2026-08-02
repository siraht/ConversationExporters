import { isJsonObject } from "./json";
import type { JsonObject, JsonValue } from "./types";

const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|token|secret|password|signature|signedurl|session)/i;

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key) || key.toLowerCase().startsWith("x-amz-")) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactJson(value: JsonValue, depth = 0): JsonValue {
  if (depth > 30) return "[REDACTED:MAX_DEPTH]";
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? redactUrl(value) : value;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, depth + 1));
  if (!isJsonObject(value)) return value;

  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactJson(child, depth + 1);
  }
  return output;
}

