import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE_SETTINGS } from "../../src/core/types";
import { GrokClient, capturedResponses } from "../../src/grok/client";
import { isAllowedGrokApiRequest } from "../../src/grok/endpoints";
import { FixtureTransport } from "../fixtures/grok";

const settings = {
  ...DEFAULT_CAPTURE_SETTINGS,
  requestDelayMs: 0,
  maxRetries: 0,
  includeWorkspaces: false,
};

describe("Grok endpoint allowlist", () => {
  it("allows only known same-origin API shapes", () => {
    expect(isAllowedGrokApiRequest("/rest/app-chat/conversations?pageSize=100", "GET")).toBe(true);
    expect(isAllowedGrokApiRequest("/rest/app-chat/conversations/abc/response-node?includeThreads=true", "GET")).toBe(true);
    expect(isAllowedGrokApiRequest("/rest/app-chat/conversations/abc/load-responses", "POST")).toBe(true);
    expect(isAllowedGrokApiRequest("/rest/workspaces/workspace-1", "GET")).toBe(true);
    expect(isAllowedGrokApiRequest("/rest/workspaces/workspace-1/projects", "GET")).toBe(false);
    expect(isAllowedGrokApiRequest("https://evil.example/rest/app-chat/conversations", "GET")).toBe(false);
    expect(isAllowedGrokApiRequest("/rest/app-chat/conversations/abc/load-responses", "GET")).toBe(false);
    expect(isAllowedGrokApiRequest("/rest/app-chat/conversations/../../secrets", "GET")).toBe(false);
  });
});

describe("Grok inventory", () => {
  it("follows page tokens to exhaustion and deduplicates IDs visibly", async () => {
    const transport = new FixtureTransport(new Map([
      ["GET /rest/app-chat/conversations?pageSize=100", [{
        conversations: [
          { conversationId: "a", title: "Alpha", modifyTime: "2026-01-01T00:00:00Z" },
          { conversationId: "b", title: "Beta" },
        ],
        nextPageToken: "page-2",
      }]],
      ["GET /rest/app-chat/conversations?pageSize=100&pageToken=page-2", [{
        data: { conversations: [
          { conversationId: "b", title: "Beta duplicate" },
          { conversationId: "c", title: "Gamma", workspaces: [{ workspaceId: "ws-1" }] },
        ] },
      }]],
    ]));

    const inventory = await new GrokClient({ transport, settings }).inventory();
    expect(inventory.complete).toBe(true);
    expect(inventory.pages).toHaveLength(2);
    expect(inventory.conversations.map((conversation) => conversation.id)).toEqual(["a", "b", "c"]);
    expect(inventory.conversations.at(-1)?.workspaceIds).toEqual(["ws-1"]);
    expect(inventory.warnings).toContainEqual(expect.objectContaining({ code: "CONVERSATION_ID_DUPLICATE" }));
  });

  it("fails closed on repeated page tokens", async () => {
    const transport = new FixtureTransport(new Map([
      ["GET /rest/app-chat/conversations?pageSize=100", [{ conversations: [], nextPageToken: "loop" }]],
      ["GET /rest/app-chat/conversations?pageSize=100&pageToken=loop", [{ conversations: [], nextPageToken: "loop" }]],
    ]));

    await expect(new GrokClient({ transport, settings }).inventory()).rejects.toMatchObject({
      code: "INVENTORY_TOKEN_CYCLE",
    });
  });

  it("merges every paginated workspace scope into the completeness inventory", async () => {
    const transport = new FixtureTransport(new Map([
      ["GET /rest/app-chat/conversations?pageSize=100", [{
        conversations: [{ conversationId: "global", title: "Global" }],
      }]],
      ["GET /rest/workspaces?pageSize=100&orderBy=ORDER_BY_LAST_USE_TIME", [{
        workspaces: [{ workspaceId: "workspace-1", name: "Project" }],
      }]],
      ["GET /rest/app-chat/conversations?pageSize=100&workspaceId=workspace-1", [{
        conversations: [
          { conversationId: "global", title: "Global" },
          { conversationId: "project-only", title: "Project only" },
        ],
      }]],
    ]));

    const inventory = await new GrokClient({
      transport,
      settings: { ...settings, includeWorkspaces: true },
    }).inventory();
    expect(inventory.complete).toBe(true);
    expect(inventory.pages).toHaveLength(2);
    expect(inventory.pages[1]).toMatchObject({ workspaceId: "workspace-1", itemCount: 2 });
    expect(inventory.conversations.map((conversation) => conversation.id)).toEqual(["global", "project-only"]);
    expect(inventory.conversations.every((conversation) => conversation.workspaceIds.includes("workspace-1"))).toBe(true);
    expect(inventory.warnings).toEqual([]);
  });
});

describe("Grok conversation capture", () => {
  it("captures metadata, response graph, and bounded response batches", async () => {
    const responseIds = Array.from({ length: 3 }, (_, index) => `r${index + 1}`);
    const transport = new FixtureTransport(new Map([
      ["GET /rest/app-chat/conversations/c1", [{ conversationId: "c1", title: "Metadata" }]],
      ["GET /rest/app-chat/conversations/c1/response-node?includeThreads=true", [{
        responseNodes: responseIds.map((responseId) => ({ responseId })),
      }]],
      ["POST /rest/app-chat/conversations/c1/load-responses", [
        { responses: [{ responseId: "r1", sender: "human", message: "Hello" }, { responseId: "r2", sender: "assistant", message: "Hi" }] },
        { responses: [{ responseId: "r3", sender: "human", message: "Again" }] },
      ]],
    ]));

    const client = new GrokClient({ transport, settings: { ...settings, responseBatchSize: 2 } });
    const { capture, findings } = await client.captureConversation({ conversationId: "c1", title: "Test" });
    expect(findings).toEqual([]);
    expect(capture.responseBatches).toHaveLength(2);
    expect(capturedResponses(capture).map((value) => (value as { responseId: string }).responseId)).toEqual(responseIds);
    expect(transport.requests.filter((request) => request.method === "POST").map((request) => request.body)).toEqual([
      { responseIds: ["r1", "r2"] },
      { responseIds: ["r3"] },
    ]);
  });

  it("follows response cursors and rejects cursor cycles", async () => {
    const transport = new FixtureTransport(new Map([
      ["GET /rest/app-chat/conversations/c1", [{}]],
      ["GET /rest/app-chat/conversations/c1/response-node?includeThreads=true", [{ responseNodes: [{ responseId: "r1" }] }]],
      ["POST /rest/app-chat/conversations/c1/load-responses", [
        { responses: [], hasMore: true, nextCursor: "again" },
        { responses: [], hasMore: true, nextCursor: "again" },
      ]],
    ]));

    await expect(new GrokClient({ transport, settings }).captureConversation({ conversationId: "c1" }))
      .rejects.toMatchObject({ code: "RESPONSE_CURSOR_CYCLE" });
  });
});

describe("Grok supporting metadata", () => {
  it("paginates assets and captures current workspace detail records", async () => {
    const transport = new FixtureTransport(new Map([
      ["GET /rest/assets?pageSize=100&orderBy=ORDER_BY_LAST_USE_TIME", [{
        assets: [{ id: "asset-1", key: "one.png" }],
        nextPageToken: "assets-2",
      }]],
      ["GET /rest/assets?pageSize=100&orderBy=ORDER_BY_LAST_USE_TIME&pageToken=assets-2", [{
        data: { assets: [{ id: "asset-2", key: "two.png" }] },
      }]],
      ["GET /rest/workspaces?pageSize=100&orderBy=ORDER_BY_LAST_USE_TIME", [{
        workspaces: [{ workspaceId: "workspace-1", name: "Research" }],
      }]],
      ["GET /rest/workspaces/workspace-1", [{ workspaceId: "workspace-1", name: "Research", kind: "WORKSPACE_KIND_PROJECT" }]],
    ]));
    const client = new GrokClient({
      transport,
      settings: { ...settings, includeAssets: true, includeWorkspaces: true },
    });
    const supporting = await client.captureSupportingMetadata();
    expect(supporting.assets?.complete).toBe(true);
    expect(supporting.assets?.items).toHaveLength(2);
    expect(supporting.assets?.pages).toHaveLength(2);
    expect(supporting.workspaces?.items).toHaveLength(1);
    expect(supporting.workspaceDetails["workspace-1"]).toEqual({
      workspaceId: "workspace-1",
      name: "Research",
      kind: "WORKSPACE_KIND_PROJECT",
    });
  });

  it("records optional adapter failures instead of aborting text capture", async () => {
    const transport = new FixtureTransport(new Map());
    const supporting = await new GrokClient({
      transport,
      settings: { ...settings, includeAssets: true, includeWorkspaces: true },
    }).captureSupportingMetadata();
    expect(supporting.assets?.complete).toBe(false);
    expect(supporting.assets?.findings[0]?.code).toBe("ASSET_LIBRARY_CAPTURE_FAILED");
    expect(supporting.workspaces?.findings[0]?.code).toBe("WORKSPACE_CAPTURE_FAILED");
  });
});
