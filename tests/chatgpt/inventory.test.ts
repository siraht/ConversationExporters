import { describe, expect, it, vi } from "vitest";

import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import type { JsonValue } from "../../src/core/types";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import { ChatGptInventoryEngine, DEFAULT_INVENTORY_SETTINGS, InventoryError, runWorkspaceInventories } from "../../src/chatgpt/inventory";
import { BRIDGE_PROTOCOL_VERSION, type ApiSuccessResponse } from "../../src/extension/protocol";

const workspace: DiscoveredWorkspace = {
  accountId: "account-1",
  workspaceFingerprint: "a".repeat(32),
  label: "Synthetic",
  kind: "personal",
  deactivated: false,
};

describe("ChatGPT complete inventory", () => {
  it("unions main, archived, project, and shared memberships after every chain terminates", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const transport = scriptedTransport((operation) => {
      if (operation.operation === "conversation_page") {
        if (operation.parameters.archived) return page([{ id: "conversation-2", title: "Archived", create_time: 2, update_time: 3 }], 1, operation.parameters.offset);
        return page([{ id: "conversation-1", title: "Main", create_time: 1, update_time: 2 }], 1, operation.parameters.offset);
      }
      if (operation.operation === "project_page") return {
        items: [{ gizmo: {
          gizmo: { id: "project-1", display: { name: "Project" }, instructions: "Synthetic project instructions" },
          files: [{ id: "metadata-1", file_id: "project-file-1", name: "brief.pdf", type: "application/pdf", size: 42 }],
        } }],
        cursor: null,
      };
      if (operation.operation === "project_conversation_page") return { items: [{ id: "conversation-1", title: "Main", create_time: 1, update_time: 2 }], cursor: null };
      if (operation.operation === "shared_page") return {
        items: [
          { id: "share-1", conversation_id: "conversation-1", title: "Main" },
          { id: "share-2", title: "Share only" },
        ],
        total: 2,
      };
      throw new Error(`Unexpected ${operation.operation}`);
    });
    const inventory = await new ChatGptInventoryEngine({
      transport,
      filesystem,
      workspace,
      settings: DEFAULT_INVENTORY_SETTINGS,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    }).run();
    expect(inventory.complete).toBe(true);
    expect(inventory.chains).toHaveLength(5);
    expect(inventory.conversations).toHaveLength(3);
    expect(inventory.projects).toEqual([expect.objectContaining({
      projectId: "project-1",
      instructions: "Synthetic project instructions",
      files: [expect.objectContaining({ providerId: "project-file-1", originalName: "brief.pdf", byteSize: 42 })],
    })]);
    const main = inventory.conversations.find((conversation) => conversation.conversationId === "conversation-1")!;
    expect(main.memberships.map((membership) => membership.scope).sort()).toEqual(["main", "project", "shared"]);
    expect(filesystem.paths().filter((path) => path.startsWith("source/inventory/"))).toHaveLength(5);
    expect(await filesystem.exists("inventory.json")).toBe(true);
    expect(await filesystem.exists("reports/reconciliation.json")).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain("account-1");
  });

  it("continues offset inventory until a normal empty page when the provider omits total", async () => {
    const offsets: number[] = [];
    const transport = scriptedTransport((operation) => {
      if (operation.operation !== "conversation_page") throw new Error("unexpected operation");
      offsets.push(operation.parameters.offset);
      return operation.parameters.offset === 0
        ? page([{ id: "conversation-1", title: "One", create_time: 1, update_time: 2 }], null, 0)
        : page([], null, operation.parameters.offset);
    });
    const inventory = await new ChatGptInventoryEngine({
      transport,
      filesystem: new MemoryArchiveFileSystem(),
      workspace,
      settings: { ...DEFAULT_INVENTORY_SETTINGS, includeArchived: false, includeProjects: false, includeShared: false },
    }).run();
    expect(offsets).toEqual([0, 1]);
    expect(inventory.chains[0]?.terminationReason).toBe("empty_page");
  });

  it("fails closed on premature empty pages, cursor cycles, page limits, and byte limits", async () => {
    const cases: Array<{ expected: string; transport: ChatGptTransport; settings?: Partial<typeof DEFAULT_INVENTORY_SETTINGS> }> = [
      {
        expected: "INVENTORY_PREMATURE_EMPTY_PAGE",
        transport: scriptedTransport(() => page([], 10, 0)),
      },
      {
        expected: "INVENTORY_PAGE_LIMIT",
        transport: scriptedTransport(() => page([{ id: "conversation-1", title: null, create_time: null, update_time: null }], null, 0)),
        settings: { maxPagesPerChain: 1 },
      },
      {
        expected: "INVENTORY_BYTE_LIMIT",
        transport: scriptedTransport(() => page([], 0, 0), 10_000),
        settings: { maxInventoryBytes: 10 },
      },
    ];
    for (const item of cases) {
      const engine = new ChatGptInventoryEngine({
        transport: item.transport,
        filesystem: new MemoryArchiveFileSystem(),
        workspace,
        settings: {
          ...DEFAULT_INVENTORY_SETTINGS,
          includeArchived: false,
          includeProjects: false,
          includeShared: false,
          ...item.settings,
        },
      });
      await expect(engine.run()).rejects.toMatchObject({ code: item.expected });
    }
  });

  it("fails closed when project cursors cycle or claim continuation after an empty page", async () => {
    for (const nextCursor of ["cursor-1", "cursor-2"] as const) {
      let projectCalls = 0;
      const transport = scriptedTransport((operation) => {
        if (operation.operation === "conversation_page") return page([], 0, 0);
        if (operation.operation === "project_page") {
          projectCalls += 1;
          if (nextCursor === "cursor-2") return { items: [], cursor: nextCursor };
          return { items: [{ gizmo: { gizmo: { id: "project-1" } } }], cursor: "cursor-1" };
        }
        throw new Error("unexpected operation");
      });
      const engine = new ChatGptInventoryEngine({
        transport,
        filesystem: new MemoryArchiveFileSystem(),
        workspace,
        settings: { ...DEFAULT_INVENTORY_SETTINGS, includeArchived: false, includeProjects: true, includeShared: false },
      });
      await expect(engine.run()).rejects.toMatchObject({ code: nextCursor === "cursor-2" ? "INVENTORY_PREMATURE_EMPTY_PAGE" : "INVENTORY_CURSOR_CYCLE" });
      expect(projectCalls).toBeGreaterThan(0);
    }
  });

  it("writes raw evidence before refusing to publish an incomplete inventory", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const engine = new ChatGptInventoryEngine({
      transport: scriptedTransport(() => page([{ id: "conversation-1", title: null, create_time: null, update_time: null }], null, 0)),
      filesystem,
      workspace,
      settings: { ...DEFAULT_INVENTORY_SETTINGS, maxPagesPerChain: 1, includeArchived: false, includeProjects: false, includeShared: false },
    });
    await expect(engine.run()).rejects.toBeInstanceOf(InventoryError);
    expect(filesystem.paths().some((path) => path.startsWith("source/inventory/main/"))).toBe(true);
    expect(await filesystem.exists("inventory.json")).toBe(false);
  });

  it("inventories multiple selected workspaces into isolated filesystems and collision-safe logical keys", async () => {
    const first = new MemoryArchiveFileSystem();
    const second = new MemoryArchiveFileSystem();
    const secondWorkspace = { ...workspace, accountId: "account-2", workspaceFingerprint: "b".repeat(32), label: "Second" };
    const transport = scriptedTransport((operation) => {
      if (operation.operation !== "conversation_page") throw new Error("unexpected operation");
      return page([{ id: "same-conversation-id", title: "Synthetic", create_time: 1, update_time: 2 }], 1, 0);
    });
    const results = await runWorkspaceInventories({
      transport,
      targets: [
        { workspace, filesystem: first },
        { workspace: secondWorkspace, filesystem: second },
      ],
      settings: { ...DEFAULT_INVENTORY_SETTINGS, includeArchived: false, includeProjects: false, includeShared: false },
    });
    expect(results).toHaveLength(2);
    const keys = [...results.values()].map((inventory) => inventory.conversations[0]?.logicalKey);
    expect(new Set(keys).size).toBe(2);
    expect(await first.exists("inventory.json")).toBe(true);
    expect(await second.exists("inventory.json")).toBe(true);
  });

  it("retains remotely absent conversations and snapshots the previous complete inventory", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const first = new ChatGptInventoryEngine({
      transport: scriptedTransport((operation) => operation.operation === "conversation_page"
        ? page([{ id: "conversation-removed", title: "Retained", create_time: 1, update_time: 2 }], 1, 0)
        : (() => { throw new Error("unexpected operation"); })()),
      filesystem,
      workspace,
      settings: { ...DEFAULT_INVENTORY_SETTINGS, includeArchived: false, includeProjects: false, includeShared: false },
    });
    await first.run();
    const second = new ChatGptInventoryEngine({
      transport: scriptedTransport(() => page([], 0, 0)),
      filesystem,
      workspace,
      settings: { ...DEFAULT_INVENTORY_SETTINGS, includeArchived: false, includeProjects: false, includeShared: false },
    });
    const inventory = await second.run();
    expect(inventory.conversations).toHaveLength(0);
    expect(inventory.absentConversations?.map((item) => item.conversationId)).toEqual(["conversation-removed"]);
    expect(filesystem.paths().filter((path) => path.startsWith("source/inventory/snapshots/"))).toHaveLength(1);
  });
});

function page(items: JsonValue[], total: number | null, offset: number): JsonValue {
  return { items, total, offset, limit: 100 };
}

function scriptedTransport(handler: (operation: ChatGptOperationParameters) => JsonValue, responseBytes?: number): ChatGptTransport {
  return {
    request: vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
      const body = handler(operation);
      return {
        requestId: "request-1",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        ok: true,
        status: 200,
        body,
        responseBytes: responseBytes ?? JSON.stringify(body).length,
        correlationId: "correlation-1",
      };
    }),
  };
}
