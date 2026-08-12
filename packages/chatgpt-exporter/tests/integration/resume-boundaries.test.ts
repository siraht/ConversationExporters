import { describe, expect, it, vi } from "vitest";

import { ChatGptCaptureEngine } from "../../src/chatgpt/capture-engine";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import type { ArchiveFileSystem } from "../../src/core/filesystem";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { prettyJson } from "../../src/core/serialization";
import type { ConversationInventory, JsonValue } from "../../src/core/types";
import { BRIDGE_PROTOCOL_VERSION, type ApiSuccessResponse } from "../../src/extension/protocol";
import { conversationDetail } from "../fixtures/chatgpt";

const workspace: DiscoveredWorkspace = {
  accountId: "account-1",
  workspaceFingerprint: "a".repeat(32),
  label: "Synthetic",
  kind: "personal",
  deactivated: false,
};

describe("capture interruption and resume boundaries", () => {
  it.each([
    ["raw revision", (path: string) => path.includes("/source/detail-")],
    ["derived conversation", (path: string) => path.endsWith("/conversation.json")],
    ["final completion marker", (path: string) => path.endsWith("/complete.json") && path.startsWith("conversations/")],
  ])("resumes after a one-time %s write failure", async (_name, shouldFail) => {
    const inner = await fixtureFilesystem();
    const firstTransport = fixtureTransport();
    await expect(new ChatGptCaptureEngine({
      transport: firstTransport,
      filesystem: new FaultOnceFilesystem(inner, shouldFail),
      workspace,
      runId: "interrupted",
      includeAssets: false,
      includeAccountArtifacts: false,
    }).run()).rejects.toThrow("Synthetic interrupted write");

    const resumeTransport = fixtureTransport();
    const resumed = await new ChatGptCaptureEngine({
      transport: resumeTransport,
      filesystem: inner,
      workspace,
      runId: "resumed",
      includeAssets: false,
      includeAccountArtifacts: false,
    }).run();
    expect(resumed.failedCount).toBe(0);
    expect(resumed.capturedCount + resumed.rebuiltCount).toBe(1);
    const failedAtRaw = shouldFail("conversations/conversation-1/source/detail-fixture.json");
    expect(resumeTransport.request.mock.calls.filter(([operation]) => operation.operation === "conversation_batch")).toHaveLength(failedAtRaw ? 1 : 0);
    expect(await inner.exists("conversations/conversation-1/complete.json")).toBe(true);
  });

  it("retries a partial asset after an interrupted content-addressed write without refetching the conversation", async () => {
    const inner = await fixtureFilesystem();
    const detail = conversationDetail();
    detail.mapping["user-1"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [{ content_type: "file", asset_pointer: "data:text/plain;base64,c3ludGhldGljIGFzc2V0" }],
    };
    const first = await new ChatGptCaptureEngine({
      transport: fixtureTransport(detail),
      filesystem: new FaultOnceFilesystem(inner, (path) => path.startsWith("assets/")),
      workspace,
      runId: "asset-interrupted",
      includeAccountArtifacts: false,
    }).run();
    expect(first.partialAssetCount).toBe(1);

    const resumeTransport = fixtureTransport(detail);
    const resumed = await new ChatGptCaptureEngine({
      transport: resumeTransport,
      filesystem: inner,
      workspace,
      runId: "asset-resumed",
      includeAccountArtifacts: false,
    }).run();
    expect(resumed).toMatchObject({ rebuiltCount: 1, partialAssetCount: 0, failedCount: 0 });
    expect(resumeTransport.request).not.toHaveBeenCalled();
    expect((await inner.listPaths("assets")).length).toBe(1);
  });
});

class FaultOnceFilesystem implements ArchiveFileSystem {
  private failed = false;

  constructor(private readonly inner: ArchiveFileSystem, private readonly shouldFail: (path: string) => boolean) {}

  async writeTextAtomic(path: string, content: string): Promise<void> {
    this.interrupt(path);
    return this.inner.writeTextAtomic(path, content);
  }

  async writeBytesAtomic(path: string, content: Uint8Array): Promise<void> {
    this.interrupt(path);
    return this.inner.writeBytesAtomic(path, content);
  }

  async writeByteChunksAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    this.interrupt(path);
    return this.inner.writeByteChunksAtomic(path, chunks);
  }

  readText(path: string) { return this.inner.readText(path); }
  readBytes(path: string) { return this.inner.readBytes(path); }
  exists(path: string) { return this.inner.exists(path); }
  byteSize(path: string) { return this.inner.byteSize(path); }
  readByteChunks(path: string, chunkSize?: number) { return this.inner.readByteChunks(path, chunkSize); }
  listPaths(prefix?: string) { return this.inner.listPaths(prefix); }
  remove(path: string) { return this.inner.remove(path); }

  private interrupt(path: string): void {
    if (!this.failed && this.shouldFail(path)) {
      this.failed = true;
      throw new Error(`Synthetic interrupted write at ${path}`);
    }
  }
}

async function fixtureFilesystem(): Promise<MemoryArchiveFileSystem> {
  const filesystem = new MemoryArchiveFileSystem();
  const inventory: ConversationInventory = {
    schemaVersion: 1,
    provider: "chatgpt-web",
    workspaceFingerprint: workspace.workspaceFingerprint,
    generatedAt: "2026-08-01T00:00:00.000Z",
    complete: true,
    chains: [{ chainId: "main", scope: "main", complete: true, terminationReason: "declared_total_reached", pageCount: 1, itemCount: 1, uniqueConversationCount: 1 }],
    pages: [],
    projects: [],
    conversations: [{
      logicalKey: `${workspace.workspaceFingerprint}/conversation-1`,
      conversationId: "conversation-1",
      title: "Synthetic",
      createTime: 1,
      updateTime: 2,
      memberships: [{ scope: "main" }],
      listingHashes: ["listing"],
      listingRecords: [{ id: "conversation-1", title: "Synthetic" }],
    }],
  };
  await filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
  return filesystem;
}

function fixtureTransport(detail = conversationDetail()): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    if (operation.operation !== "conversation_batch") throw new Error(`unexpected ${operation.operation}`);
    const body: JsonValue = [detail as unknown as JsonValue];
    return {
      requestId: "request",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: true,
      status: 200,
      body,
      responseBytes: JSON.stringify(body).length,
      correlationId: "correlation",
    };
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}
