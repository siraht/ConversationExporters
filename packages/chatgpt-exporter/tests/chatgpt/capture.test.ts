import { describe, expect, it, vi } from "vitest";

import type { InventoryConversation, JsonValue } from "../../src/core/types";
import { ChatGptDetailFetcher, DetailCaptureError } from "../../src/chatgpt/capture";
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

describe("ChatGPT batch-first detail retrieval", () => {
  it("uses complete batch records without single-detail requests", async () => {
    const transport = transportFor((operation) => {
      if (operation.operation === "conversation_batch") return [conversationDetail() as unknown as JsonValue];
      throw new Error(`unexpected ${operation.operation}`);
    });
    const result = await new ChatGptDetailFetcher(transport, workspace).fetchAll([inventoryItem()]);
    expect(result.conversations[0]).toMatchObject({ source: "batch" });
    expect(result.batches[0]).toMatchObject({ missingConversationIds: [], suspiciousConversationIds: [] });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("accepts only the live compact null-root batch variant", async () => {
    const compact = conversationDetail() as unknown as { mapping: Record<string, Record<string, JsonValue>> };
    delete compact.mapping["root-1"]!.parent;
    delete compact.mapping["root-1"]!.message;
    const transport = transportFor((operation) => {
      if (operation.operation === "conversation_batch") return [compact as unknown as JsonValue];
      throw new Error(`unexpected ${operation.operation}`);
    });
    const result = await new ChatGptDetailFetcher(transport, workspace).fetchAll([inventoryItem()]);
    expect(result.conversations[0]).toMatchObject({ source: "batch", detail: { mapping: { "root-1": { parent: null, message: null } } } });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("keeps compact live batches with ISO and omitted timestamps on the batch path", async () => {
    const compact = conversationDetail() as unknown as {
      create_time: JsonValue;
      update_time: JsonValue;
      mapping: Record<string, Record<string, JsonValue>>;
    };
    compact.create_time = "2026-08-01T12:00:00.000Z";
    compact.update_time = "2026-08-01T12:00:01.000Z";
    delete compact.mapping["root-1"]!.parent;
    delete compact.mapping["root-1"]!.message;
    delete (compact.mapping["user-1"]!.message as Record<string, JsonValue>).create_time;
    const transport = transportFor((operation) => {
      if (operation.operation === "conversation_batch") return [compact as unknown as JsonValue];
      throw new Error(`unexpected ${operation.operation}`);
    });

    const result = await new ChatGptDetailFetcher(transport, workspace).fetchAll([inventoryItem()]);

    expect(result.conversations[0]).toMatchObject({
      source: "batch",
      detail: {
        create_time: 1_785_585_600,
        mapping: { "user-1": { message: { create_time: null } } },
      },
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("falls back when a compact placeholder is not a detached root", async () => {
    const compactNonRoot = conversationDetail() as unknown as { mapping: Record<string, Record<string, JsonValue>> };
    delete compactNonRoot.mapping["user-1"]!.parent;
    delete compactNonRoot.mapping["user-1"]!.message;
    const transport = transportFor((operation) => {
      if (operation.operation === "conversation_batch") return [compactNonRoot as unknown as JsonValue];
      if (operation.operation === "conversation_detail") return conversationDetail() as unknown as JsonValue;
      throw new Error(`unexpected ${operation.operation}`);
    });
    const result = await new ChatGptDetailFetcher(transport, workspace).fetchAll([inventoryItem()]);
    expect(result.conversations[0]).toMatchObject({ source: "single", fallbackReason: "batch_graph_suspicious" });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it("falls back individually for omitted, malformed, duplicate, and graph-suspicious batch records", async () => {
    const items = ["conversation-1", "conversation-2", "conversation-3", "conversation-4"].map(inventoryItem);
    const transport = transportFor((operation) => {
      if (operation.operation === "conversation_batch") {
        const malformed = { ...conversationDetail({ id: "conversation-2" }), mapping: [] } as unknown as JsonValue;
        const duplicate = conversationDetail({ id: "conversation-3" }) as unknown as JsonValue;
        const suspicious = conversationDetail({ id: "conversation-4", current_node: "missing-node" }) as unknown as JsonValue;
        return [malformed, duplicate, duplicate, suspicious];
      }
      if (operation.operation === "conversation_detail") return conversationDetail({ id: operation.parameters.conversationId }) as unknown as JsonValue;
      throw new Error(`unexpected ${operation.operation}`);
    });
    const result = await new ChatGptDetailFetcher(transport, workspace).fetchAll(items);
    expect(result.conversations.map((item) => item.source)).toEqual(["single", "single", "single", "single"]);
    expect(result.conversations.map((item) => item.fallbackReason)).toEqual([
      "batch_missing",
      "batch_invalid",
      "batch_duplicate",
      "batch_graph_suspicious",
    ]);
    expect(transport.request).toHaveBeenCalledTimes(5);
  });

  it("uses the share adapter for share-only inventory records", async () => {
    const shared = inventoryItem("share_share-1");
    shared.memberships = [{ scope: "shared", shareId: "share-1" }];
    const transport = transportFor((operation) => {
      if (operation.operation === "shared_detail") return conversationDetail({ id: "shared-provider-record" }) as unknown as JsonValue;
      throw new Error(`unexpected ${operation.operation}`);
    });
    const result = await new ChatGptDetailFetcher(transport, workspace).fetchAll([shared]);
    expect(result.conversations[0]?.source).toBe("shared");
  });

  it("refuses an invalid single-detail fallback instead of accepting partial capture", async () => {
    const transport = transportFor((operation) => {
      if (operation.operation === "conversation_batch") return [];
      if (operation.operation === "conversation_detail") return conversationDetail({ current_node: "missing" }) as unknown as JsonValue;
      throw new Error(`unexpected ${operation.operation}`);
    });
    await expect(new ChatGptDetailFetcher(transport, workspace).fetchAll([inventoryItem()])).rejects.toBeInstanceOf(DetailCaptureError);
  });

  it("checkpoints each completed batch before requesting the next batch", async () => {
    const transient = Object.assign(new Error("synthetic throttle"), { retryable: true });
    const transport = transportFor((operation) => {
      if (operation.operation !== "conversation_batch") throw new Error(`unexpected ${operation.operation}`);
      const id = operation.parameters.conversationIds[0]!;
      if (id === "conversation-2") throw transient;
      return [conversationDetail({ id }) as unknown as JsonValue];
    });
    const checkpoints: string[][] = [];
    const capture = new ChatGptDetailFetcher(transport, workspace, 1).fetchAll(
      [inventoryItem("conversation-1"), inventoryItem("conversation-2")],
      async (checkpoint) => { checkpoints.push(checkpoint.conversations.map((item) => item.inventory.conversationId)); },
    );

    await expect(capture).rejects.toBe(transient);
    expect(checkpoints).toEqual([["conversation-1"]]);
  });
});

function inventoryItem(id = "conversation-1"): InventoryConversation {
  return {
    logicalKey: `${workspace.workspaceFingerprint}/${id}`,
    conversationId: id,
    title: "Synthetic",
    createTime: 1,
    updateTime: 2,
    memberships: [{ scope: "main" }],
    listingHashes: ["listing-hash"],
  };
}

function transportFor(handler: (operation: ChatGptOperationParameters) => JsonValue): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    const body = handler(operation);
    return {
      requestId: "request-1",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: true,
      status: 200,
      body,
      responseBytes: JSON.stringify(body).length,
      correlationId: "correlation-1",
    };
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}
