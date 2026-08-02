import type { JsonObject, JsonValue } from "../core/types";

export const MAX_ASSET_CHUNK_BYTES = 1_048_576;
const HANDLE_TTL_MS = 10 * 60_000;

interface AssetHandle {
  url: string;
  mediaType: string | null;
  expectedBytes: number | null;
  expiresAt: number;
}

export class PageAssetSessions {
  private readonly handles = new Map<string, AssetHandle>();

  constructor(
    private readonly fetcher: typeof fetch = (input, init) => window.fetch(input, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  open(descriptor: JsonValue): JsonObject {
    const value = requireObject(descriptor, "file download descriptor");
    const rawUrl = firstString(value, ["download_url", "downloadUrl", "url"]);
    if (!rawUrl) throw new AssetSessionError("ASSET_URL_MISSING", "ChatGPT did not return an asset download URL.");
    const url = validateAssetUrl(rawUrl);
    const handleId = crypto.randomUUID();
    const mediaType = firstString(value, ["mime_type", "mimeType", "content_type"]);
    const expectedBytes = firstNumber(value, ["size", "bytes", "content_length", "file_size_bytes", "fileSizeBytes"]);
    this.handles.set(handleId, {
      url: url.toString(),
      mediaType,
      expectedBytes,
      expiresAt: this.now() + HANDLE_TTL_MS,
    });
    return {
      handleId,
      mediaType,
      expectedBytes,
      maxChunkBytes: MAX_ASSET_CHUNK_BYTES,
    };
  }

  async chunk(handleId: string, offset: number, length: number, signal?: AbortSignal): Promise<JsonObject> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AssetSessionError("ASSET_OFFSET_INVALID", "Asset offset is invalid.");
    if (!Number.isInteger(length) || length < 1 || length > MAX_ASSET_CHUNK_BYTES) throw new AssetSessionError("ASSET_CHUNK_INVALID", "Asset chunk length is invalid.");
    const handle = this.handles.get(handleId);
    if (!handle) throw new AssetSessionError("ASSET_HANDLE_UNKNOWN", "Asset handle is unknown or already closed.");
    if (handle.expiresAt <= this.now()) {
      this.handles.delete(handleId);
      throw new AssetSessionError("ASSET_HANDLE_EXPIRED", "Asset handle expired; reopen the asset descriptor.");
    }
    let response: Response;
    try {
      const assetUrl = new URL(handle.url);
      const sameOrigin = typeof location !== "undefined" && assetUrl.origin === location.origin;
      response = await this.fetcher(handle.url, {
        method: "GET",
        credentials: sameOrigin ? "include" : "omit",
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new AssetSessionError("ASSET_NETWORK_ERROR", "Asset chunk request failed before a response was received.", true);
    }
    validateAssetUrl(response.url || handle.url);
    if (response.status !== 200 && response.status !== 206) {
      throw new AssetSessionError("ASSET_HTTP_ERROR", `Asset chunk request failed with HTTP ${response.status}.`, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    const contentRange = parseContentRange(response.headers.get("Content-Range"));
    if (response.status === 206 && (!contentRange || contentRange.start !== offset)) {
      throw new AssetSessionError("ASSET_RANGE_MISMATCH", "Asset server returned a mismatched byte range.");
    }
    if (response.status === 200 && offset !== 0) throw new AssetSessionError("ASSET_RANGE_UNSUPPORTED", "Asset server ignored a required byte range.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > length) throw new AssetSessionError("ASSET_CHUNK_TOO_LARGE", "Asset server returned more bytes than requested.");
    const totalBytes = contentRange?.total ?? handle.expectedBytes ?? (response.status === 200 ? bytes.byteLength : null);
    const nextOffset = offset + bytes.byteLength;
    const eof = totalBytes === null ? bytes.byteLength < length : nextOffset >= totalBytes;
    handle.mediaType ??= response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() || null;
    handle.expectedBytes ??= totalBytes;
    handle.expiresAt = this.now() + HANDLE_TTL_MS;
    return {
      handleId,
      offset,
      nextOffset,
      byteLength: bytes.byteLength,
      dataBase64: encodeBase64(bytes),
      eof,
      totalBytes,
      mediaType: handle.mediaType,
    };
  }

  close(handleId: string): JsonObject {
    const existed = this.handles.delete(handleId);
    return { handleId, closed: existed };
  }
}

export class AssetSessionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "AssetSessionError";
  }
}

export function validateAssetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value, typeof location === "undefined" ? "https://chatgpt.com" : location.origin);
  } catch {
    throw new AssetSessionError("ASSET_URL_INVALID", "ChatGPT returned an invalid asset URL.");
  }
  if (url.protocol !== "https:") throw new AssetSessionError("ASSET_ORIGIN_REJECTED", "Asset URL must use HTTPS.");
  const host = url.hostname.toLowerCase();
  const allowed = host === "chatgpt.com"
    || host.endsWith(".chatgpt.com")
    || host === "files.oaiusercontent.com"
    || host.endsWith(".oaiusercontent.com")
    || host.endsWith(".blob.core.windows.net");
  if (!allowed) throw new AssetSessionError("ASSET_ORIGIN_REJECTED", "Asset URL origin is not on the provider media allowlist.");
  if (url.username || url.password) throw new AssetSessionError("ASSET_URL_INVALID", "Asset URL must not contain user information.");
  return url;
}

export function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new AssetSessionError("ASSET_BASE64_INVALID", "Asset chunk contained invalid base64.");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const block = 32_768;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + block, bytes.length)));
  }
  return btoa(binary);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || (total !== null && (!Number.isSafeInteger(total) || total <= end))) return null;
  return { start, end, total };
}

function requireObject(value: JsonValue, name: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssetSessionError("ASSET_DESCRIPTOR_INVALID", `${name} must be an object.`);
  return value;
}

function firstString(value: Record<string, JsonValue>, keys: string[]): string | null {
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string;
  return null;
}

function firstNumber(value: Record<string, JsonValue>, keys: string[]): number | null {
  for (const key of keys) if (typeof value[key] === "number" && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) return value[key] as number;
  return null;
}
