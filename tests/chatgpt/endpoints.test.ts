import { describe, expect, it } from "vitest";

import { EndpointValidationError, parseOperationRequest, resolveEndpoint, validateOperation } from "../../src/chatgpt/endpoints";
import { BRIDGE_PROTOCOL_VERSION, parseApiRequest } from "../../src/extension/protocol";

describe("ChatGPT endpoint allowlist", () => {
  it("constructs listing endpoints from typed parameters", () => {
    expect(resolveEndpoint({
      operation: "conversation_page",
      parameters: { offset: 28, limit: 28, archived: true },
    })).toMatchObject({
      method: "GET",
      path: "/backend-api/conversations?offset=28&limit=28&order=updated&is_archived=true",
      requiresAuthentication: true,
    });
  });

  it("accepts only bounded identifiers, cursors, pages, and batch sizes", () => {
    expect(() => resolveEndpoint({
      operation: "conversation_detail",
      parameters: { conversationId: "../../api/auth/session" },
    })).toThrow(EndpointValidationError);
    expect(() => resolveEndpoint({
      operation: "conversation_page",
      parameters: { offset: 0, limit: 101, archived: false },
    })).toThrow("limit must be 1-100");
    expect(() => resolveEndpoint({
      operation: "conversation_batch",
      parameters: { conversationIds: Array.from({ length: 11 }, (_, index) => `conversation-${index}`) },
    })).toThrow("1-10");
  });

  it("constructs shared, account-artifact, and file descriptor adapters without arbitrary URLs", () => {
    expect(resolveEndpoint({ operation: "project_conversation_page", parameters: { projectId: "project-1", cursor: "0" } }).path)
      .toBe("/backend-api/gizmos/project-1/conversations?cursor=0");
    expect(() => parseOperationRequest({
      operation: "project_conversation_page",
      parameters: { projectId: "project-1", cursor: "0", limit: 100 },
    })).toThrow("unexpected parameters");
    expect(resolveEndpoint({ operation: "shared_page", parameters: { offset: 100, limit: 100 } }).path)
      .toBe("/backend-api/shared_conversations?order=updated&limit=100&offset=100");
    expect(resolveEndpoint({ operation: "account_artifact", parameters: { kind: "memories" } }).path)
      .toBe("/backend-api/memories?include_memory_entries=true");
    expect(resolveEndpoint({ operation: "account_artifact", parameters: { kind: "settings" } }).path)
      .toBe("/backend-api/settings");
    expect(resolveEndpoint({ operation: "account_artifact", parameters: { kind: "beta_features" } }).path)
      .toBe("/backend-api/settings/beta_features");
    expect(resolveEndpoint({
      operation: "asset_open",
      parameters: { fileId: "file-1", conversationId: "conversation-1", projectId: null },
    }).path).toBe("/backend-api/files/download/file-1?conversation_id=conversation-1&inline=false");
    expect(() => resolveEndpoint({
      operation: "asset_open",
      parameters: { fileId: "file-1", conversationId: null, projectId: null },
    })).toThrow("exactly one");
    const handleId = "00000000-0000-4000-8000-000000000000";
    expect(() => validateOperation({ operation: "asset_chunk", parameters: { handleId, offset: 0, length: 1_048_576 } })).not.toThrow();
    expect(() => validateOperation({ operation: "asset_chunk", parameters: { handleId, offset: 0, length: 1_048_577 } })).toThrow("chunk length");
    expect(() => validateOperation({ operation: "asset_close", parameters: { handleId: "../../private" } })).toThrow("handleId");
  });

  it("rejects arbitrary paths, methods, bodies, headers, and extra parameters structurally", () => {
    expect(() => parseOperationRequest({
      operation: "conversation_detail",
      parameters: { conversationId: "conversation-1", path: "http://localhost/private" },
    })).toThrow("unexpected parameters");
    expect(() => parseOperationRequest({ operation: "DELETE", parameters: {} })).toThrow("unsupported operation");
  });

  it("validates the complete versioned bridge request at both boundaries", () => {
    const request = parseApiRequest({
      requestId: "request-1",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workspaceId: "account-1",
      timeoutMs: 10_000,
      operation: "conversation_page",
      parameters: { offset: 0, limit: 28, archived: false },
    });
    expect(request.operation).toBe("conversation_page");
    expect(() => parseApiRequest({ ...request, timeoutMs: 999 })).toThrow("timeoutMs");
    expect(() => parseApiRequest({ ...request, protocolVersion: 999 })).toThrow("protocolVersion");
    for (const injected of [
      { path: "http://localhost/private" },
      { url: "//evil.example/private" },
      { method: "DELETE" },
      { headers: { [["Author", "ization"].join("")]: "synthetic" } },
      { body: { is_visible: false } },
    ]) {
      expect(() => parseApiRequest({ ...request, ...injected })).toThrow("unexpected fields");
    }
  });
});
