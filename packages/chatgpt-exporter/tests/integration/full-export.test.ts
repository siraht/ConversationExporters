import { describe, expect, it, vi } from "vitest";

import { auditArchive } from "../../src/chatgpt/audit";
import { ChatGptCaptureEngine } from "../../src/chatgpt/capture-engine";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import { ChatGptInventoryEngine, DEFAULT_INVENTORY_SETTINGS, runWorkspaceInventories } from "../../src/chatgpt/inventory";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { sha256Hex } from "../../src/core/hash";
import type { JsonValue } from "../../src/core/types";
import { BRIDGE_PROTOCOL_VERSION, type ApiSuccessResponse } from "../../src/extension/protocol";
import { conversationDetail } from "../fixtures/chatgpt";

const workspace: DiscoveredWorkspace = {
  accountId: "account-1",
  workspaceFingerprint: "a".repeat(32),
  label: "Synthetic",
  kind: "personal",
  deactivated: false,
};

describe("deterministic full-scope export integration", () => {
  it("inventories every scope, recovers an omitted batch record, captures content/assets, audits, and repeats byte-identically", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const transport = fullTransport();
    const inventory = await new ChatGptInventoryEngine({
      transport,
      filesystem,
      workspace,
      settings: { ...DEFAULT_INVENTORY_SETTINGS, pageSize: 2 },
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    }).run();
    expect(inventory).toMatchObject({ complete: true });
    expect(inventory.pages.length).toBe(7);
    expect(inventory.projects?.map((project) => [project.projectId, project.files.length])).toEqual([["project-1", 0], ["project-2", 1]]);
    expect(inventory.conversations).toHaveLength(6);
    expect(inventory.conversations.find((item) => item.conversationId === "conversation-1")?.memberships.map((item) => item.scope).sort())
      .toEqual(["main", "project", "shared"]);

    const result = await new ChatGptCaptureEngine({
      transport,
      filesystem,
      workspace,
      runId: "full-export",
      batchSize: 3,
      now: () => new Date("2026-08-01T00:00:01.000Z"),
    }).run();
    expect(result).toMatchObject({
      inventoryCount: 6,
      capturedCount: 6,
      failedCount: 0,
      partialAssetCount: 0,
      projectAssetCount: 1,
      partialProjectAssetCount: 0,
      accountArtifactStatus: "complete",
    });
    expect(transport.request.mock.calls.filter(([operation]) => operation.operation === "conversation_detail"))
      .toHaveLength(1);
    const audit = await auditArchive({ filesystem, extensionVersion: "0.0.0-test", now: () => new Date("2026-08-01T00:00:02.000Z") });
    expect(audit).toMatchObject({
      terminalState: "complete",
      expectedConversationCount: 6,
      completeConversationCount: 6,
      projectCount: 2,
      logicalAssetReferenceCount: 4,
      physicalAssetCount: 4,
      partialAssetReferenceCount: 0,
    });
    const authoritativeBefore = await authoritativeHash(filesystem);

    const repeatTransport = fullTransport();
    const repeat = await new ChatGptCaptureEngine({
      transport: repeatTransport,
      filesystem,
      workspace,
      runId: "full-export-repeat",
      batchSize: 3,
      now: () => new Date("2026-08-01T00:00:03.000Z"),
    }).run();
    expect(repeat).toMatchObject({ capturedCount: 0, rebuiltCount: 0, skippedCount: 6, failedCount: 0 });
    expect(repeatTransport.request).not.toHaveBeenCalled();
    expect(await authoritativeHash(filesystem)).toBe(authoritativeBefore);
  });

  it("keeps identical provider IDs isolated across selected workspaces and accepts a recognized empty workspace", async () => {
    const first = new MemoryArchiveFileSystem();
    const second = new MemoryArchiveFileSystem();
    const emptyWorkspace: DiscoveredWorkspace = {
      ...workspace,
      accountId: "account-empty",
      workspaceFingerprint: "b".repeat(32),
      label: "Empty",
    };
    const transport = workspaceTransport();
    const results = await runWorkspaceInventories({
      transport,
      targets: [{ workspace, filesystem: first }, { workspace: emptyWorkspace, filesystem: second }],
      settings: { ...DEFAULT_INVENTORY_SETTINGS, includeArchived: false, includeProjects: false, includeShared: false },
    });
    expect(results.get(workspace.workspaceFingerprint)?.conversations[0]?.logicalKey).toBe(`${workspace.workspaceFingerprint}/same-id`);
    expect(results.get(emptyWorkspace.workspaceFingerprint)?.conversations).toEqual([]);
    const emptyCapture = await new ChatGptCaptureEngine({
      transport,
      filesystem: second,
      workspace: emptyWorkspace,
      runId: "empty",
      includeAssets: false,
      includeAccountArtifacts: false,
    }).run();
    expect(emptyCapture).toMatchObject({ inventoryCount: 0, capturedCount: 0, failedCount: 0 });
    expect((await auditArchive({ filesystem: second, extensionVersion: "0.0.0-test" })).terminalState).toBe("complete");
  });
});

function fullTransport(): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const projectBytes = new TextEncoder().encode("project-level file");
  const handles = new Set<string>();
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    let body: JsonValue;
    if (operation.operation === "conversation_page") {
      const all = operation.parameters.archived
        ? [listing("conversation-2"), listing("conversation-4")]
        : [listing("conversation-1"), listing("conversation-2"), listing("conversation-3")];
      body = { items: all.slice(operation.parameters.offset, operation.parameters.offset + operation.parameters.limit), total: all.length, offset: operation.parameters.offset, limit: operation.parameters.limit };
    } else if (operation.operation === "project_page") {
      body = { items: [
        { gizmo: { gizmo: { id: "project-1", display: { name: "One" } }, files: [] } },
        { gizmo: { gizmo: { id: "project-2", display: { name: "Two" } }, files: [{ file_id: "project-file", name: "project.txt", type: "text/plain", size: projectBytes.byteLength }] } },
      ], cursor: null };
    } else if (operation.operation === "project_conversation_page") {
      body = operation.parameters.projectId === "project-1"
        ? { items: [listing("conversation-1"), listing("project-only")], cursor: null }
        : { items: [], cursor: null };
    } else if (operation.operation === "shared_page") {
      body = { items: [{ id: "share-owned", conversation_id: "conversation-1", title: "Owned" }, { id: "share-only", title: "Share only" }], total: 2 };
    } else if (operation.operation === "conversation_batch") {
      body = operation.parameters.conversationIds
        .filter((id) => id !== "conversation-2")
        .map((id) => detailFor(id) as unknown as JsonValue);
    } else if (operation.operation === "conversation_detail") {
      body = detailFor(operation.parameters.conversationId) as unknown as JsonValue;
    } else if (operation.operation === "shared_detail") {
      body = detailFor("shared-provider-detail") as unknown as JsonValue;
    } else if (operation.operation === "account_artifact") {
      body = operation.parameters.kind === "memories" ? { memories: [] } : {};
    } else if (operation.operation === "asset_open") {
      expect(operation.parameters).toMatchObject({ fileId: "project-file", conversationId: null, projectId: "project-2" });
      const handleId = crypto.randomUUID();
      handles.add(handleId);
      body = { handleId, mediaType: "text/plain", expectedBytes: projectBytes.byteLength };
    } else if (operation.operation === "asset_chunk") {
      expect(handles.has(operation.parameters.handleId)).toBe(true);
      const chunk = projectBytes.slice(operation.parameters.offset, operation.parameters.offset + operation.parameters.length);
      body = {
        handleId: operation.parameters.handleId,
        offset: operation.parameters.offset,
        nextOffset: operation.parameters.offset + chunk.byteLength,
        byteLength: chunk.byteLength,
        dataBase64: btoa(String.fromCharCode(...chunk)),
        eof: operation.parameters.offset + chunk.byteLength >= projectBytes.byteLength,
      };
    } else if (operation.operation === "asset_close") {
      body = { handleId: operation.parameters.handleId, closed: handles.delete(operation.parameters.handleId) };
    } else {
      throw new Error(`unexpected ${operation.operation}`);
    }
    return success(body);
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}

function workspaceTransport(): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (operation: ChatGptOperationParameters, workspaceId: string | null): Promise<ApiSuccessResponse> => {
    if (operation.operation !== "conversation_page") throw new Error(`unexpected ${operation.operation}`);
    const items = workspaceId === "account-empty" ? [] : [listing("same-id")];
    return success({ items, total: items.length, offset: operation.parameters.offset, limit: operation.parameters.limit });
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}

function listing(id: string): JsonValue {
  return { id, title: `Synthetic ${id}`, create_time: 1, update_time: 2 };
}

function detailFor(id: string) {
  const detail = conversationDetail({ id, title: `Synthetic ${id}` });
  if (id === "conversation-1") {
    detail.mapping["user-1"]!.children.push("assistant-alt");
    detail.mapping["assistant-alt"] = {
      id: "assistant-alt", parent: "user-1", children: [],
      message: {
        id: "message-assistant-alt", author: { role: "assistant" }, create_time: 3,
        content: { content_type: "text", parts: ["Alternate branch"] }, metadata: {},
      },
    };
  } else if (id === "conversation-2") {
    detail.mapping["assistant-1"]!.message!.content = { content_type: "code", code: "const synthetic = true;", language: "typescript" };
    detail.mapping["assistant-1"]!.message!.metadata = { citations: [{ url: "https://example.test/source", title: "Source" }] };
  } else if (id === "conversation-3") {
    detail.mapping["user-1"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [
        { content_type: "image_asset_pointer", asset_pointer: "data:image/png;base64,iVBORw0KGgo=" },
        { content_type: "audio_asset_pointer", asset_pointer: "data:audio/wav;base64,UklGRg==" },
        { content_type: "future_widget", payload: "synthetic" },
      ],
    };
  } else if (id === "conversation-4") {
    detail.mapping["assistant-1"]!.message!.content = { content_type: "canvas", text: "Synthetic canvas" };
  } else if (id === "project-only") {
    detail.mapping["assistant-1"]!.message!.content = { content_type: "browsing_result", result: "Synthetic browsing result" };
    detail.mapping["assistant-1"]!.message!.metadata = { is_async_task_result_message: true, deep_research_version: "full" };
  }
  return detail;
}

function success(body: JsonValue): ApiSuccessResponse {
  return {
    requestId: "request",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ok: true,
    status: 200,
    body,
    responseBytes: JSON.stringify(body).length,
    correlationId: "correlation",
  };
}

async function authoritativeHash(filesystem: MemoryArchiveFileSystem): Promise<string> {
  const paths = (await filesystem.listPaths()).filter((path) => path.startsWith("conversations/") || path.startsWith("assets/") || path.startsWith("source/inventory/"));
  const rows: string[] = [];
  for (const path of paths) rows.push(`${path}\0${await sha256Hex((await filesystem.readBytes(path))!)}`);
  return sha256Hex(rows.sort().join("\n"));
}
