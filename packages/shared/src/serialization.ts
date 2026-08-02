import { sortJson } from "./json";
import type { JsonValue } from "./types";

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(sortJson(toJsonValue(value)), null, 2)}\n`;
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(sortJson(toJsonValue(value)))}\n`;
}

export function parseJson<T>(value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

