import { GrokExporterError } from "../core/errors";
import type { AssetFetcher, AssetFetchResult } from "../core/assets";
import type { CancellationSignal } from "../core/types";

const ALLOWED_ASSET_HOSTS = new Set([
  "grok.com",
  "assets.grok.com",
  "imagine-public.x.ai",
  "pbs.twimg.com",
  "video.twimg.com",
]);

export class BrowserAssetFetcher implements AssetFetcher {
  constructor(private readonly maximumBytes = 512 * 1024 * 1024) {}

  async fetch(value: string, cancellation?: CancellationSignal): Promise<AssetFetchResult> {
    await cancellation?.waitIfPaused?.();
    cancellation?.throwIfCancelled();
    const url = new URL(value, "https://grok.com");
    assertAllowedAssetUrl(url);
    const response = await fetch(url, {
      credentials: url.hostname === "grok.com" ? "include" : "omit",
      cache: "no-store",
      redirect: "follow",
    });
    if (!response.ok) {
      throw new GrokExporterError(`Asset request failed with HTTP ${response.status}.`, {
        code: "ASSET_HTTP_ERROR",
        httpStatus: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }
    const finalUrl = new URL(response.url || url.href);
    assertAllowedAssetUrl(finalUrl);
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maximumBytes) {
      throw new GrokExporterError(`Asset exceeds the ${this.maximumBytes}-byte safety limit.`, { code: "ASSET_TOO_LARGE" });
    }
    const bytes = response.body
      ? await readCappedBody(response.body, this.maximumBytes, cancellation)
      : new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      finalUrl: finalUrl.href,
      ...(response.headers.get("Content-Type") === null ? {} : { mediaType: response.headers.get("Content-Type") as string }),
    };
  }
}

async function readCappedBody(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  cancellation?: CancellationSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      await cancellation?.waitIfPaused?.();
      cancellation?.throwIfCancelled();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("Asset exceeded configured size limit.");
        throw new GrokExporterError(`Asset exceeds the ${maximumBytes}-byte safety limit.`, { code: "ASSET_TOO_LARGE" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function assertAllowedAssetUrl(url: URL): void {
  if (url.protocol !== "https:" || !ALLOWED_ASSET_HOSTS.has(url.hostname)) {
    throw new GrokExporterError(`Asset host is not allowlisted: ${url.hostname}`, {
      code: "ASSET_HOST_NOT_ALLOWED",
    });
  }
}
