import { describe, expect, it, vi } from "vitest";
import { downloadConversationAssets, type AssetFetcher } from "../../src/core/assets";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import type { NormalizedConversation } from "../../src/core/types";

function conversationFixture(): NormalizedConversation {
  return {
    schemaVersion: 1,
    provider: "grok",
    id: "c1",
    title: "Assets",
    sourceUrl: "https://grok.com/c/c1",
    capturedAt: "2026-07-20T00:00:00Z",
    workspaceIds: [],
    rootMessageIds: ["r1"],
    messages: [{
      id: "r1",
      role: "assistant",
      text: "Two copies",
      markdown: "Two copies",
      childIds: [],
      citations: [],
      attachments: [
        { kind: "image", sourceUrl: "https://assets.grok.com/same.png" },
        { kind: "image", sourceUrl: "https://assets.grok.com/same.png" },
      ],
      extensions: {},
      warnings: [],
    }],
    extensions: {},
    provenance: { rawCaptureHash: "raw", sourcePaths: [] },
    warnings: [],
  };
}

describe("asset downloads", () => {
  it("hashes, stores, and deduplicates identical source URLs", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const fetch = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      finalUrl: "https://assets.grok.com/same.png",
    }));
    const conversation = conversationFixture();
    const result = await downloadConversationAssets({
      conversation,
      basePath: "conversations/c1",
      filesystem,
      fetcher: { fetch } satisfies AssetFetcher,
    });
    expect(result.status).toBe("complete");
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.records).toHaveLength(2);
    expect(conversation.messages[0]?.attachments[0]?.localPath).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
    expect(conversation.messages[0]?.attachments[1]?.localPath).toBe(conversation.messages[0]?.attachments[0]?.localPath);
    expect(filesystem.paths()).toHaveLength(1);
  });

  it("records failures without turning them into successful assets", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const conversation = conversationFixture();
    conversation.messages[0]!.attachments = [
      { kind: "document", id: "missing-url" },
      { kind: "image", sourceUrl: "https://assets.grok.com/fail.png" },
    ];
    const result = await downloadConversationAssets({
      conversation,
      basePath: "conversations/c1",
      filesystem,
      fetcher: { fetch: async () => { throw new Error("download failed"); } },
    });
    expect(result.status).toBe("partial");
    expect(result.records.map((record) => record.status)).toEqual(["missing_url", "failed"]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["ASSET_URL_MISSING", "ASSET_DOWNLOAD_FAILED"]);
    expect(filesystem.paths()).toEqual([]);
  });
});

