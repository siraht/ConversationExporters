import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAssetFetcher, assertAllowedAssetUrl } from "../../src/extension/asset-fetcher";

afterEach(() => vi.unstubAllGlobals());

describe("browser asset fetcher", () => {
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

