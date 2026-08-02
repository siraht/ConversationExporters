import { describe, expect, it, vi } from "vitest";

import { auditArchive } from "../../src/chatgpt/audit";
import { ChatGptCaptureEngine } from "../../src/chatgpt/capture-engine";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
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

describe("independent archive audit", () => {
  it("proves inventory/completion/normalized graph sets and publishes import indexes", async () => {
    const filesystem = await capturedArchive();
    const report = await auditArchive({ filesystem, extensionVersion: "0.0.0-test", now: () => new Date("2026-08-01T00:00:00.000Z") });
    expect(report).toMatchObject({
      terminalState: "complete",
      expectedConversationCount: 1,
      completeConversationCount: 1,
      partialAssetReferenceCount: 0,
    });
    expect(report.inventorySetHash).toBe(report.completionSetHash);
    expect(report.inventorySetHash).toBe(report.normalizedSetHash);
    expect(await filesystem.readText("indexes/conversations.jsonl")).toContain('"logicalKey"');
    expect(await filesystem.readText("reports/validation.md")).toContain("Terminal state: **complete**");
    expect(await filesystem.exists("archive.json")).toBe(true);
  });

  it("fails the terminal state when a derived file no longer matches its completion marker", async () => {
    const filesystem = await capturedArchive();
    await filesystem.writeTextAtomic("conversations/conversation-1/conversation.json", "{}\n");
    const report = await auditArchive({ filesystem, extensionVersion: "0.0.0-test" });
    expect(report.terminalState).toBe("incomplete");
    expect(report.findings.some((finding) => finding.code === "DERIVED_HASH_MISMATCH")).toBe(true);
  });

  it("keeps a completed remotely absent conversation in the import index", async () => {
    const filesystem = await capturedArchive();
    const inventory = JSON.parse((await filesystem.readText("inventory.json"))!) as ConversationInventory;
    inventory.absentConversations = inventory.conversations;
    inventory.conversations = [];
    await filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
    const report = await auditArchive({ filesystem, extensionVersion: "0.0.0-test" });
    expect(report).toMatchObject({ terminalState: "complete", expectedConversationCount: 0, extraRetainedConversationCount: 1 });
    expect(await filesystem.readText("indexes/conversations.jsonl")).toContain('"absentFromCurrentInventory":true');
  });
});

async function capturedArchive(): Promise<MemoryArchiveFileSystem> {
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
  await new ChatGptCaptureEngine({
    transport: fixtureTransport(),
    filesystem,
    workspace,
    runId: "audit-fixture",
    includeAssets: false,
    includeAccountArtifacts: false,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  }).run();
  return filesystem;
}

function fixtureTransport(): ChatGptTransport {
  return {
    request: vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
      if (operation.operation !== "conversation_batch") throw new Error(`unexpected ${operation.operation}`);
      const body: JsonValue = [conversationDetail() as unknown as JsonValue];
      return {
        requestId: "request",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        ok: true,
        status: 200,
        body,
        responseBytes: JSON.stringify(body).length,
        correlationId: "correlation",
      };
    }),
  };
}
