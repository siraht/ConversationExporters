import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAssetFetcher, assertAllowedAssetUrl } from "../../src/extension/asset-fetcher";
import { RunControl } from "../../src/core/control";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("browser asset fetcher", () => {
  it("aborts a stalled fetch at the bounded timeout and clears timers", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    })));
    const result = new BrowserAssetFetcher(100, 1000).fetch("https://assets.grok.com/file.png");
    const rejected = expect(result).rejects.toMatchObject({ code: "ASSET_TIMEOUT", retryable: true });
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts in-flight body streaming when cancelled and clears timers", async () => {
    vi.useFakeTimers();
    const control = new RunControl();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
      } }));
    }));
    const result = new BrowserAssetFetcher().fetch("https://assets.grok.com/file.png", control);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    control.cancel();
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("accepts only audited HTTPS media hosts", () => {
    expect(() => assertAllowedAssetUrl(new URL("https://assets.grok.com/file.png"))).not.toThrow();
    expect(() => assertAllowedAssetUrl(new URL("https://evil.example/file.png"))).toThrow("not allowlisted");
    expect(() => assertAllowedAssetUrl(new URL("http://assets.grok.com/file.png"))).toThrow("not allowlisted");
  });

  it("reads allowed responses and enforces streamed byte limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    })));
    const result = await new BrowserAssetFetcher(3).fetch("https://assets.grok.com/file.png");
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.mediaType).toBe("image/png");

    await expect(new BrowserAssetFetcher(2).fetch("https://assets.grok.com/file.png"))
      .rejects.toMatchObject({ code: "ASSET_TOO_LARGE" });
  });
});
