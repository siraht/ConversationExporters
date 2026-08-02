import { describe, expect, it, vi } from "vitest";

import { AssetSessionError, decodeBase64, MAX_ASSET_CHUNK_BYTES, PageAssetSessions } from "../../src/chatgpt/asset-session";

describe("page-local chunked asset sessions", () => {
  it("keeps signed URLs private and returns bounded sequential chunks", async () => {
    const bytes = new TextEncoder().encode("synthetic asset bytes");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      expect(init?.credentials).toBe("omit");
      const range = new Headers(init?.headers).get("Range")!;
      const match = /bytes=(\d+)-(\d+)/.exec(range)!;
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), bytes.length - 1);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": "text/plain",
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    });
    const sessions = new PageAssetSessions(fetcher, () => 1_000);
    const queryKey = ["s", "ig"].join("");
    const signedUrl = new URL("https://files.oaiusercontent.com/file");
    signedUrl.searchParams.set(queryKey, "synthetic");
    const opened = sessions.open({ download_url: signedUrl.toString(), size: bytes.length });
    expect(JSON.stringify(opened)).not.toContain(`${queryKey}=`);
    const first = await sessions.chunk(opened.handleId as string, 0, 8);
    const second = await sessions.chunk(opened.handleId as string, first.nextOffset as number, 1_024);
    const joined = new Uint8Array([...decodeBase64(first.dataBase64 as string), ...decodeBase64(second.dataBase64 as string)]);
    expect(new TextDecoder().decode(joined)).toBe("synthetic asset bytes");
    expect(second.eof).toBe(true);
    expect(sessions.close(opened.handleId as string)).toMatchObject({ closed: true });
  });

  it("includes page credentials for same-origin provider downloads", async () => {
    vi.stubGlobal("location", new URL("https://chatgpt.com/"));
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        expect(init?.credentials).toBe("include");
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { "Content-Range": "bytes 0-2/3" },
        });
      });
      const sessions = new PageAssetSessions(fetcher);
      const opened = sessions.open({
        download_url: "/backend-api/estuary/content?fixture=synthetic",
        file_size_bytes: 3,
      });
      expect(opened.expectedBytes).toBe(3);
      await expect(sessions.chunk(opened.handleId as string, 0, 3)).resolves.toMatchObject({
        byteLength: 3,
        eof: true,
        totalBytes: 3,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects arbitrary origins, invalid handles, oversized chunks, and range mismatches", async () => {
    const sessions = new PageAssetSessions(vi.fn<typeof fetch>());
    expect(() => sessions.open({ download_url: "http://localhost/private" })).toThrow("HTTPS");
    expect(() => sessions.open({ download_url: "https://evil.example/private" })).toThrow("allowlist");
    await expect(sessions.chunk(crypto.randomUUID(), 0, MAX_ASSET_CHUNK_BYTES + 1)).rejects.toBeInstanceOf(AssetSessionError);

    const mismatch = new PageAssetSessions(vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1]), {
      status: 206,
      headers: { "Content-Range": "bytes 9-9/10" },
    })));
    const opened = mismatch.open({ download_url: "https://chatgpt.com/backend-api/estuary/content?id=synthetic" });
    await expect(mismatch.chunk(opened.handleId as string, 0, 1)).rejects.toMatchObject({ code: "ASSET_RANGE_MISMATCH" });
  });

  it("expires opaque handles without leaking their signed descriptor", async () => {
    let now = 0;
    const sessions = new PageAssetSessions(vi.fn<typeof fetch>(), () => now);
    const signedUrl = new URL("https://files.oaiusercontent.com/file");
    signedUrl.searchParams.set(["s", "ig"].join(""), "private-fixture");
    const opened = sessions.open({ download_url: signedUrl.toString() });
    now = 11 * 60_000;
    const error = await sessions.chunk(opened.handleId as string, 0, 1).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ASSET_HANDLE_EXPIRED" });
    expect(String(error)).not.toContain("private-fixture");
  });
});
