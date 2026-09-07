import { describe, expect, it } from "vitest";
import { deriveCoverage } from "../src/coverage";
const entry = (namespace: string, path: string, data: unknown = {}) => ({ namespace, path, blob: new Blob([JSON.stringify(data)]) });

describe("inventory coverage", () => {
  it("keeps workspace identities separate and groups created dates, not capture dates", async () => {
    const result = await deriveCoverage([
      entry("chatgpt-web", "ChatGPTExport-a/inventory.json", { conversations: [{ conversationId: "same", title: "First", createTime: 1704067200 }] }),
      entry("chatgpt-web", "ChatGPTExport-b/inventory.json", { conversations: [{ conversationId: "same", title: "Second", updateTime: 1706745600 }] }),
      entry("chatgpt-web", "ChatGPTExport-a/conversations/same/complete.json", { completedAt: "2026-09-01" }),
    ]);
    expect(result[0].rows.map((row) => [row.id, row.status, row.dateKind])).toEqual([
      ["ChatGPTExport-b/same", "pending", "updated"], ["ChatGPTExport-a/same", "captured", "created"],
    ]);
    expect(result[0].bins).toEqual([
      { month: "2024-01", captured: 1, pending: 0, failed: 0, retained: 0 },
      { month: "2024-02", captured: 0, pending: 1, failed: 0, retained: 0 },
    ]);
  });
  it("handles all other inventory shapes, unknown dates and retained records without reading raw blobs", async () => {
    const raw = { text: () => { throw new Error("must not read raw conversation"); } } as unknown as Blob;
    const results = await deriveCoverage([
      entry("claude-web", "inventory.json", { conversations: [{ uuid: "c", name: "Claude", created_at: "2020-01-02" }] }),
      entry("claude-web", "conversations/c/complete.json"), entry("claude-web", "conversations/c/error.json"),
      entry("gemini-web", "inventory.json", { conversations: [{ id: "g", title: "Gemini", updated_at: "2024-02-03" }] }),
      entry("gemini-web", "conversations/old/complete.json"),
      entry("gemini-web", "conversations/old/metadata.json", { title: "Retained", created_at: "2019-01-01" }),
      entry("google-ai-studio", "inventory.json", { prompts: [{ id: "p", inventory: ["p", null, null, null, ["Prompt title"]] }] }),
      entry("google-ai-studio", "prompts/p/complete.json"),
      entry("grok-web", "inventory.json", { conversations: [{ conversation: { id: "x", title: "Grok", createdAt: "2023-03-02" } }] }),
      { namespace: "grok-web", path: "conversations/x/conversation.json", blob: raw },
    ]);
    expect(results[1].rows[0]).toMatchObject({ title: "Claude", status: "failed", dateKind: "created" });
    expect(results[2].rows[1]).toMatchObject({ title: "Retained", status: "retained", dateKind: "created" });
    expect(results[3].unknownDate.captured).toBe(1);
    expect(results[3].rows[0]).toMatchObject({ title: "Prompt title", date: null });
    expect(results[4].rows[0]).toMatchObject({ title: "Grok", status: "pending" });
  });
  it("uses latest per-conversation journal status over stale completion markers", async () => {
    const result = await deriveCoverage([
      entry("grok-web", "inventory.json", { conversations: [{ id: "x" }] }),
      entry("grok-web", "conversations/x/complete.json"),
      entry("grok-web", "runs/new.json", { conversations: { x: { conversationId: "x", state: "terminal_failure", updatedAt: "2026-09-07T10:00:00Z" } } }),
      entry("grok-web", "runs/old.json", { conversations: { x: { conversationId: "x", state: "complete", updatedAt: "2026-09-01T10:00:00Z" } } }),
    ]);
    expect(result[4].rows[0].status).toBe("failed");
    expect(result[4].unknownDate.failed).toBe(1);
  });
});
