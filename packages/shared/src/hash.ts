import { stableStringify } from "./json";
import type { JsonValue } from "./types";

const encoder = new TextEncoder();

export async function sha256Hex(value: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string"
    ? encoder.encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashJson(value: JsonValue): Promise<string> {
  return sha256Hex(stableStringify(value));
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

