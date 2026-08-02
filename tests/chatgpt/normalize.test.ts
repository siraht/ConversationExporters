import { describe, expect, it } from "vitest";

import { renderConversationMarkdown } from "../../src/core/markdown";
import type { InventoryConversation } from "../../src/core/types";
import { normalizeConversation } from "../../src/chatgpt/normalize";
import { conversationDetail } from "../fixtures/chatgpt";

const inventory: InventoryConversation = {
  logicalKey: `${"a".repeat(32)}/conversation-1`,
  conversationId: "conversation-1",
  title: "Synthetic",
  createTime: 1,
  updateTime: 2,
  memberships: [{ scope: "main" }, { scope: "project", projectId: "project-1" }],
  listingHashes: ["listing"],
};

describe("loss-aware ChatGPT normalization", () => {
  it("preserves every graph node and renders the selected branch deterministically", () => {
    const raw = conversationDetail();
    raw.mapping["assistant-alt"] = {
      id: "assistant-alt",
      parent: "user-1",
      children: [],
      message: {
        id: "message-assistant-alt",
        author: { role: "assistant" },
        create_time: 1_700_000_003,
        content: { content_type: "text", parts: ["Alternative response."] },
      },
    };
    raw.mapping["user-1"]!.children.push("assistant-alt");
    const normalized = normalizeConversation(raw, inventory, "a".repeat(32));
    expect(normalized.nodes).toHaveLength(4);
    expect(normalized.messages).toHaveLength(3);
    expect(normalized.messages.find((message) => message.nodeId === "assistant-1")?.selected).toBe(true);
    expect(normalized.messages.find((message) => message.nodeId === "assistant-alt")?.selected).toBe(false);
    const first = renderConversationMarkdown(normalized);
    expect(first.indexOf("Synthetic response.")).toBeLessThan(first.indexOf("Alternative response."));
    expect(renderConversationMarkdown(normalized)).toBe(first);
  });

  it("normalizes multimodal assets, citations, code, tools, Canvas, reasoning, and unknown blocks without dropping raw data", () => {
    const raw = conversationDetail();
    const message = raw.mapping["assistant-1"]!.message!;
    message.content = {
      content_type: "multimodal_text",
      parts: [
        "Text",
        { content_type: "image_asset_pointer", asset_pointer: "sediment://file-1" },
        { content_type: "citation", title: "Source", url: "https://example.com/source" },
        { content_type: "mystery_block", payload: { retained: true } },
      ],
    };
    message.metadata = { content_references: [{ title: "Unsafe", url: "javascript:alert(1)" }] };
    const normalized = normalizeConversation(raw, inventory, "a".repeat(32));
    const kinds = normalized.messages.find((item) => item.nodeId === "assistant-1")!.parts.map((part) => part.kind);
    expect(kinds).toEqual(["text", "asset", "citation", "unknown", "citation"]);
    expect(normalized.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["UNKNOWN_CONTENT_PART", "UNSAFE_CITATION_URL"]));
    expect(JSON.stringify(normalized)).toContain("retained");

    for (const contentType of ["code", "execution_output", "tool_result", "reasoning_summary", "canvas"] as const) {
      message.content = { content_type: contentType, text: `${contentType} body`, language: "ts" };
      expect(normalizeConversation(raw, inventory, "a".repeat(32)).messages.find((item) => item.nodeId === "assistant-1")?.parts[0]?.kind).toBe(contentType);
    }
  });

  it("escapes unsafe HTML and uses a longer fence around embedded backticks", () => {
    const raw = conversationDetail();
    raw.title = "<unsafe>";
    raw.mapping["assistant-1"]!.message!.content = { content_type: "code", text: "```embedded```", language: "md" };
    const markdown = renderConversationMarkdown(normalizeConversation(raw, inventory, "a".repeat(32)));
    expect(markdown).toContain("# &lt;unsafe&gt;");
    expect(markdown).toContain("````md\n```embedded```\n````");
  });

  it("recognizes browsing and completed deep-research result records while retaining metadata", () => {
    const raw = conversationDetail();
    const message = raw.mapping["assistant-1"]!.message!;
    message.content = { content_type: "tether_browsing_display", result: "Research synthesis" };
    message.metadata = { is_async_task_result_message: true, deep_research_version: "full", task_id: "synthetic-task" };
    const normalized = normalizeConversation(raw, inventory, "a".repeat(32));
    const parts = normalized.messages.find((item) => item.nodeId === "assistant-1")!.parts;
    expect(parts.map((part) => part.kind)).toEqual(["tool_result", "deep_research"]);
    expect(JSON.stringify(parts)).toContain("synthetic-task");
  });
});
