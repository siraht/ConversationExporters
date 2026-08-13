import { describe, expect, it } from "vitest";
import type { BrowserArchiveEntry } from "@conversation-exporters/shared/indexeddb-filesystem";
import { summarizeBrowserArchives } from "../src/archive-summary";

function entry(namespace: string, path: string, value: unknown = "x"): BrowserArchiveEntry {
  return { namespace, path, blob: new Blob([typeof value === "string" ? value : JSON.stringify(value)]) };
}

describe("browser archive summaries", () => {
  it("distinguishes captured ChatGPT chats from inventory totals", async () => {
    const [summary] = await summarizeBrowserArchives([
      entry("chatgpt-web", "ChatGPTExport-personal/inventory.json", { conversations: [{}, {}, {}], projects: [{}, {}] }),
      entry("chatgpt-web", "ChatGPTExport-personal/conversations/one/complete.json"),
      entry("chatgpt-web", "ChatGPTExport-personal/assets/hash.png"),
    ]);
    expect(summary).toMatchObject({ captured: 1, discovered: 3, workspaces: 1, projects: 2, assets: 1 });
  });

  it("counts Grok conversations, projects, and downloaded assets from stable paths", async () => {
    const [summary] = await summarizeBrowserArchives([
      entry("grok-web", "inventory.json", { conversations: [{}, {}] }),
      entry("grok-web", "conversations/one/complete.json"),
      entry("grok-web", "conversations/one/assets/image.webp"),
      entry("grok-web", "source/workspaces/project-one/workspace.json"),
    ]);
    expect(summary).toMatchObject({ captured: 1, discovered: 2, projects: 1, assets: 1 });
  });

  it("uses lightweight sync reports for consolidated provider records", async () => {
    const summaries = await summarizeBrowserArchives([
      entry("claude-web", "conversations.json", new Array(100).fill({})),
      entry("claude-web", "sync-report.json", { summary: { fetched: 4, unchanged: 5, retained: 2 } }),
      entry("google-ai-studio", "prompts.json", { prompts: new Array(50).fill({}) }),
      entry("google-ai-studio", "sync-report.json", { summary: { fetched: 10, unchanged: 40, retained: 3 } }),
    ]);
    expect(summaries.find((summary) => summary.namespace === "claude-web")?.captured).toBe(11);
    expect(summaries.find((summary) => summary.namespace === "google-ai-studio")?.captured).toBe(53);
  });

  it("reports complete provider-specific records and assets from the full archive layout", async () => {
    const summaries = await summarizeBrowserArchives([
      entry("claude-web", "inventory.json", { conversations: [{}, {}] }),
      entry("claude-web", "organizations/org/organization.json"),
      entry("claude-web", "organizations/org/projects/project/complete.json"),
      entry("claude-web", "conversations/chat/complete.json"),
      entry("claude-web", "conversations/chat/assets/input.pdf"),
      entry("gemini-web", "inventory.json", { conversations: [{}, {}, {}] }),
      entry("gemini-web", "gems/gem/complete.json"),
      entry("gemini-web", "conversations/chat/complete.json"),
      entry("gemini-web", "conversations/chat/assets/image.png"),
      entry("google-ai-studio", "inventory.json", { prompts: [{}, {}] }),
      entry("google-ai-studio", "prompts/prompt/complete.json"),
      entry("google-ai-studio", "prompts/prompt/assets/reference.pdf"),
    ]);
    expect(summaries.find((summary) => summary.namespace === "claude-web")).toMatchObject({ captured: 1, discovered: 2, workspaces: 1, projects: 1, assets: 1 });
    expect(summaries.find((summary) => summary.namespace === "gemini-web")).toMatchObject({ captured: 1, discovered: 3, projects: 1, assets: 1 });
    expect(summaries.find((summary) => summary.namespace === "google-ai-studio")).toMatchObject({ captured: 1, discovered: 2, assets: 1 });
  });
});
