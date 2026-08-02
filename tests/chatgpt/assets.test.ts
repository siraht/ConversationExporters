import { describe, expect, it, vi } from "vitest";

import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import type { InventoryConversation, InventoryProject, JsonValue } from "../../src/core/types";
import { ChatGptAssetManager, discoverAssets } from "../../src/chatgpt/assets";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import { BRIDGE_PROTOCOL_VERSION, type ApiSuccessResponse } from "../../src/extension/protocol";
import { conversationDetail } from "../fixtures/chatgpt";

const workspace: DiscoveredWorkspace = { accountId: "account-1", workspaceFingerprint: "a".repeat(32), label: "Synthetic", kind: "personal", deactivated: false };
const inventory: InventoryConversation = {
  logicalKey: `${workspace.workspaceFingerprint}/conversation-1`, conversationId: "conversation-1", title: "Synthetic",
  createTime: 1, updateTime: 2, memberships: [{ scope: "main" }], listingHashes: ["listing"],
};

describe("ChatGPT asset discovery and content-addressed capture", () => {
  it("discovers upload, generated media, inline, Canvas, and nested research descriptors", () => {
    const detail = conversationDetail();
    detail.mapping["user-1"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file-image", filename: "image.png" },
        { content_type: "file", file_id: "file-upload", mime_type: "application/pdf" },
        { content_type: "audio_asset_pointer", asset_pointer: "data:audio/wav;base64,YXVkaW8=" },
        { content_type: "canvas", text: "canvas text", name: "notes" },
        { content_type: "deep_research_file", file_id: "file-research" },
      ],
    };
    const assets = discoverAssets(detail);
    expect(assets.map((asset) => asset.kind)).toEqual(["generated_image", "upload", "audio", "canvas", "research"]);
    expect(JSON.stringify(assets)).not.toContain("YXVkaW8=");
  });

  it("does not mistake file citations for downloadable file descriptors", () => {
    const detail = conversationDetail();
    detail.mapping["assistant-1"]!.message!.metadata = {
      content_references: [
        {
          type: "file",
          id: "citation-record-1",
          name: "Referenced document",
          source: "source-record",
          text: "Citation text",
          extra: { quoted: true },
        },
        {
          type: "file",
          id: "citation-record-2",
          name: "Cloud reference",
          source: "source-record",
          cloud_doc_url: "https://example.invalid/private-document",
          snippet: "Citation snippet",
          start_idx: 0,
          end_idx: 8,
        },
      ],
    };

    expect(discoverAssets(detail)).toEqual([]);
  });

  it("downloads remote chunks, hashes them, and deduplicates physical files", async () => {
    const detail = conversationDetail();
    detail.mapping["user-1"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [
        { content_type: "file", file_id: "file-1", filename: "first.txt", mime_type: "text/plain" },
        { content_type: "file", file_id: "file-1", filename: "second.txt", mime_type: "text/plain" },
      ],
    };
    const filesystem = new MemoryArchiveFileSystem();
    const transport = assetTransport(new TextEncoder().encode("remote bytes"));
    const result = await new ChatGptAssetManager({ transport, filesystem, workspace }).capture(detail, inventory);
    expect(result.status).toBe("complete");
    expect(result.assets).toHaveLength(2);
    expect(new Set(result.assets.map((asset) => asset.sha256)).size).toBe(1);
    expect(filesystem.paths().filter((path) => path.startsWith("assets/"))).toHaveLength(1);
    expect(filesystem.paths().some((path) => path.startsWith("staging/"))).toBe(false);
    expect(transport.request.mock.calls.filter(([operation]) => operation.operation === "asset_open")).toHaveLength(1);
  });

  it("reports partial assets explicitly while preserving successful descriptors", async () => {
    const detail = conversationDetail();
    detail.mapping["user-1"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [
        { content_type: "file", file_id: "file-ok" },
        { content_type: "file", file_id: "file-fail" },
      ],
    };
    const transport = assetTransport(new Uint8Array([1, 2, 3]), "file-fail");
    const result = await new ChatGptAssetManager({ transport, filesystem: new MemoryArchiveFileSystem(), workspace }).capture(detail, inventory);
    expect(result.status).toBe("partial");
    expect(result.assets.map((asset) => asset.status)).toEqual(["complete", "failed"]);
    expect(result.assets[1]?.failure?.code).toBe("SYNTHETIC_ASSET_FAILURE");
  });

  it("downloads project-level files with the project-scoped adapter", async () => {
    const project: InventoryProject = {
      projectId: "project-1",
      name: "Synthetic project",
      description: null,
      instructions: null,
      createTime: null,
      updateTime: null,
      rawHash: "project-hash",
      files: [{
        logicalId: "project-1-file-1",
        providerId: "file-1",
        originalName: "brief.txt",
        mediaType: "text/plain",
        byteSize: 12,
        rawDescriptor: { file_id: "file-1", name: "brief.txt" },
      }],
    };
    const filesystem = new MemoryArchiveFileSystem();
    const transport = assetTransport(new TextEncoder().encode("project file"));
    const result = await new ChatGptAssetManager({ transport, filesystem, workspace }).captureProject(project);
    expect(result.status).toBe("complete");
    expect(result.assets[0]).toMatchObject({ providerId: "file-1", kind: "upload", status: "complete" });
    expect(transport.request.mock.calls.find(([operation]) => operation.operation === "asset_open")?.[0]).toEqual({
      operation: "asset_open",
      parameters: { fileId: "file-1", conversationId: null, projectId: "project-1" },
    });
  });
});

function assetTransport(bytes: Uint8Array, failingId?: string): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const handles = new Map<string, string>();
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    let body: JsonValue;
    if (operation.operation === "asset_open") {
      if (operation.parameters.fileId === failingId) throw Object.assign(new Error("Synthetic asset failure."), { code: "SYNTHETIC_ASSET_FAILURE", correlationId: "failure" });
      const handleId = crypto.randomUUID();
      handles.set(handleId, operation.parameters.fileId);
      body = { handleId, mediaType: "text/plain", expectedBytes: bytes.length, maxChunkBytes: 1_048_576 };
    } else if (operation.operation === "asset_chunk") {
      if (!handles.has(operation.parameters.handleId)) throw new Error("unknown handle");
      const chunk = bytes.slice(operation.parameters.offset, operation.parameters.offset + operation.parameters.length);
      body = {
        handleId: operation.parameters.handleId,
        offset: operation.parameters.offset,
        nextOffset: operation.parameters.offset + chunk.length,
        byteLength: chunk.length,
        dataBase64: btoa(String.fromCharCode(...chunk)),
        eof: operation.parameters.offset + chunk.length >= bytes.length,
        totalBytes: bytes.length,
        mediaType: "text/plain",
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
