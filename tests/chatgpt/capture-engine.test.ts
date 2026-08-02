import { describe, expect, it, vi } from "vitest";

import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { prettyJson } from "../../src/core/serialization";
import type { ConversationInventory, JsonValue } from "../../src/core/types";
import { ChatGptCaptureEngine } from "../../src/chatgpt/capture-engine";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import { BRIDGE_PROTOCOL_VERSION, type ApiSuccessResponse } from "../../src/extension/protocol";
import { conversationDetail } from "../fixtures/chatgpt";

const workspace: DiscoveredWorkspace = {
  accountId: "account-1",
  workspaceFingerprint: "a".repeat(32),
  label: "Synthetic",
  kind: "personal",
  deactivated: false,
};

describe("journaled ChatGPT capture engine", () => {
  it("writes raw revisions before deterministic derived files and a final completion marker", async () => {
    const filesystem = await fixtureFilesystem();
    const transport = fixtureTransport();
    const result = await new ChatGptCaptureEngine({ transport, filesystem, workspace, runId: "run-1", now: clock() }).run();
    expect(result).toMatchObject({ capturedCount: 1, rebuiltCount: 0, skippedCount: 0, failedCount: 0 });
    const paths = filesystem.paths();
    expect(paths).toEqual(expect.arrayContaining([
      "conversations/conversation-1/assets.json",
      "conversations/conversation-1/complete.json",
      "conversations/conversation-1/conversation.json",
      "conversations/conversation-1/conversation.md",
      "conversations/conversation-1/raw-complete.json",
      "runs/run-1.json",
    ]));
    expect(paths.some((path) => path.includes("/source/detail-"))).toBe(true);
    expect(paths.some((path) => path.includes("/source/batch-"))).toBe(true);
    const journal = JSON.parse((await filesystem.readText("runs/run-1.json"))!);
    expect(journal.entries.map((entry: { to: string }) => entry.to)).toEqual(["pending", "capturing", "writing", "complete"]);
  });

  it("performs an unchanged repeat without network requests", async () => {
    const filesystem = await fixtureFilesystem();
    await new ChatGptCaptureEngine({ transport: fixtureTransport(), filesystem, workspace, runId: "run-1", now: clock() }).run();
    const repeatTransport = fixtureTransport();
    const result = await new ChatGptCaptureEngine({ transport: repeatTransport, filesystem, workspace, runId: "run-2", now: clock() }).run();
    expect(result).toMatchObject({ capturedCount: 0, rebuiltCount: 0, skippedCount: 1 });
    expect(repeatTransport.request).not.toHaveBeenCalled();
  });

  it("rebuilds corrupted derived output from validated raw bytes without refetching", async () => {
    const filesystem = await fixtureFilesystem();
    await new ChatGptCaptureEngine({ transport: fixtureTransport(), filesystem, workspace, runId: "run-1", now: clock() }).run();
    await filesystem.writeTextAtomic("conversations/conversation-1/conversation.md", "corrupt\n");
    const transport = fixtureTransport();
    const result = await new ChatGptCaptureEngine({ transport, filesystem, workspace, runId: "run-2", now: clock() }).run();
    expect(result.rebuiltCount).toBe(1);
    expect(transport.request).not.toHaveBeenCalled();
    expect(await filesystem.readText("conversations/conversation-1/conversation.md")).toContain("Synthetic response.");
  });

  it("refetches when changed inventory listing evidence invalidates the raw marker", async () => {
    const filesystem = await fixtureFilesystem();
    await new ChatGptCaptureEngine({ transport: fixtureTransport(), filesystem, workspace, runId: "run-1", now: clock() }).run();
    const inventory = JSON.parse((await filesystem.readText("inventory.json"))!) as ConversationInventory;
    inventory.conversations[0]!.listingHashes = ["changed-listing"];
    await filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
    const transport = fixtureTransport();
    const result = await new ChatGptCaptureEngine({ transport, filesystem, workspace, runId: "run-2", now: clock() }).run();
    expect(result.capturedCount).toBe(1);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("publishes content-addressed assets, normalized links, and a global asset index", async () => {
    const filesystem = await fixtureFilesystem();
    const detail = conversationDetail();
    const encoded = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3));
    detail.mapping["user-1"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [{ content_type: "image_asset_pointer", asset_pointer: `data:image/png;base64,${encoded}` }],
    };
    const result = await new ChatGptCaptureEngine({ transport: fixtureTransport(detail), filesystem, workspace, runId: "run-assets", now: clock() }).run();
    expect(result.partialAssetCount).toBe(0);
    expect(filesystem.paths().filter((path) => path.startsWith("assets/"))).toHaveLength(1);
    expect(await filesystem.readText("conversations/conversation-1/conversation.md")).toContain("../../assets/");
    expect(await filesystem.readText("indexes/assets.jsonl")).toContain('"status":"complete"');
  });

  it("captures project-level files and skips them after validating their completion marker", async () => {
    const filesystem = await fixtureFilesystem(true);
    const firstTransport = fixtureTransport();
    const first = await new ChatGptCaptureEngine({ transport: firstTransport, filesystem, workspace, runId: "run-projects", now: clock() }).run();
    expect(first).toMatchObject({ projectAssetCount: 1, partialProjectAssetCount: 0, projectAssetStatus: "complete" });
    expect(await filesystem.readText("projects/project-1/assets.json")).toContain('"providerId": "project-file-1"');
    expect(await filesystem.readText("indexes/assets.jsonl")).toContain('"projectId":"project-1"');
    expect(firstTransport.request.mock.calls.filter(([operation]) => operation.operation === "asset_open")).toHaveLength(1);

    const repeatTransport = fixtureTransport();
    const repeat = await new ChatGptCaptureEngine({ transport: repeatTransport, filesystem, workspace, runId: "run-projects-repeat", now: clock() }).run();
    expect(repeat.projectAssetCount).toBe(1);
    expect(repeatTransport.request).not.toHaveBeenCalled();
  });

  it("keeps completed batch checkpoints when a later provider request fails", async () => {
    const filesystem = await fixtureFilesystem();
    const inventory = JSON.parse((await filesystem.readText("inventory.json"))!) as ConversationInventory;
    inventory.conversations.push({
      ...inventory.conversations[0]!,
      logicalKey: `${workspace.workspaceFingerprint}/conversation-2`,
      conversationId: "conversation-2",
      listingHashes: ["listing-2"],
      listingRecords: [{ id: "conversation-2", title: "Synthetic second" }],
    });
    inventory.chains[0]!.itemCount = 2;
    inventory.chains[0]!.uniqueConversationCount = 2;
    await filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
    const transient = Object.assign(new Error("synthetic throttle"), { code: "RATE_LIMITED", retryable: true, correlationId: "synthetic-correlation" });
    const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
      if (operation.operation !== "conversation_batch") throw new Error(`unexpected ${operation.operation}`);
      const id = operation.parameters.conversationIds[0]!;
      if (id === "conversation-2") throw transient;
      const body = [conversationDetail({ id }) as unknown as JsonValue];
      return { requestId: "request", protocolVersion: BRIDGE_PROTOCOL_VERSION, ok: true, status: 200, body, responseBytes: JSON.stringify(body).length, correlationId: "correlation" };
    });

    const run = new ChatGptCaptureEngine({
      transport: { request },
      filesystem,
      workspace,
      runId: "run-checkpoint",
      batchSize: 1,
      includeAssets: false,
      includeAccountArtifacts: false,
      now: clock(),
    }).run();
    await expect(run).rejects.toBe(transient);
    expect(await filesystem.readText("conversations/conversation-1/complete.json")).toBeDefined();
    expect(await filesystem.readText("conversations/conversation-2/complete.json")).toBeUndefined();
    const journal = JSON.parse((await filesystem.readText("runs/run-checkpoint.json"))!);
    const latest = new Map<string, string>();
    for (const entry of journal.entries) latest.set(entry.conversationId, entry.to);
    expect(Object.fromEntries(latest)).toEqual({ "conversation-1": "complete", "conversation-2": "failed" });
    expect(journal.entries.at(-1)?.error).toMatchObject({ code: "RATE_LIMITED", retryable: true, correlationId: "synthetic-correlation" });
  });
});

async function fixtureFilesystem(includeProject = false): Promise<MemoryArchiveFileSystem> {
  const filesystem = new MemoryArchiveFileSystem();
  const inventory: ConversationInventory = {
    schemaVersion: 1,
    provider: "chatgpt-web",
    workspaceFingerprint: workspace.workspaceFingerprint,
    generatedAt: "2026-08-01T00:00:00.000Z",
    complete: true,
    chains: [{ chainId: "main", scope: "main", complete: true, terminationReason: "declared_total_reached", pageCount: 1, itemCount: 1, uniqueConversationCount: 1 }],
    pages: [],
    projects: includeProject ? [{
      projectId: "project-1",
      name: "Synthetic project",
      description: null,
      instructions: "Synthetic instructions",
      createTime: 1,
      updateTime: 2,
      rawHash: "project-raw-hash",
      files: [{
        logicalId: "project-project-1-file-project-file-1-0",
        providerId: "project-file-1",
        originalName: "project.txt",
        mediaType: "text/plain",
        byteSize: 13,
        rawDescriptor: { file_id: "project-file-1", name: "project.txt" },
      }],
    }] : [],
    conversations: [{
      logicalKey: `${workspace.workspaceFingerprint}/conversation-1`,
      conversationId: "conversation-1",
      title: "Synthetic",
      createTime: 1,
      updateTime: 2,
      memberships: [{ scope: "main" }],
      listingHashes: ["listing-1"],
      listingRecords: [{ id: "conversation-1", title: "Synthetic" }],
    }],
  };
  await filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
  return filesystem;
}

function fixtureTransport(detail = conversationDetail()): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const projectBytes = new TextEncoder().encode("project bytes");
  const handles = new Set<string>();
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    let body: JsonValue;
    if (operation.operation === "account_artifact") {
      body = operation.parameters.kind === "memories"
        ? { memories: [] }
        : operation.parameters.kind === "custom_instructions"
          ? { about_user_message: "Synthetic" }
          : {};
    } else if (operation.operation === "conversation_batch") {
      body = [detail as unknown as JsonValue];
    } else if (operation.operation === "asset_open") {
      const handleId = crypto.randomUUID();
      handles.add(handleId);
      body = { handleId, mediaType: "text/plain", expectedBytes: projectBytes.byteLength, maxChunkBytes: 1_048_576 };
    } else if (operation.operation === "asset_chunk") {
      if (!handles.has(operation.parameters.handleId)) throw new Error("unknown synthetic asset handle");
      const bytes = projectBytes.slice(operation.parameters.offset, operation.parameters.offset + operation.parameters.length);
      body = {
        handleId: operation.parameters.handleId,
        offset: operation.parameters.offset,
        nextOffset: operation.parameters.offset + bytes.byteLength,
        byteLength: bytes.byteLength,
        dataBase64: btoa(String.fromCharCode(...bytes)),
        eof: operation.parameters.offset + bytes.byteLength >= projectBytes.byteLength,
      };
    } else if (operation.operation === "asset_close") {
      body = { handleId: operation.parameters.handleId, closed: handles.delete(operation.parameters.handleId) };
    } else {
      throw new Error(`unexpected ${operation.operation}`);
    }
    return { requestId: "request", protocolVersion: BRIDGE_PROTOCOL_VERSION, ok: true, status: 200, body, responseBytes: JSON.stringify(body).length, correlationId: "correlation" };
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 1, 0, 0, tick++));
}
