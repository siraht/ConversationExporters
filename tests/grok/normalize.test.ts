import { describe, expect, it } from "vitest";
import { renderConversationMarkdown } from "../../src/core/markdown";
import type { RawConversationCapture } from "../../src/core/types";
import { validateConversationCapture } from "../../src/core/validation";
import { normalizeConversation } from "../../src/grok/normalize";

function captureFixture(): RawConversationCapture {
  return {
    provider: "grok",
    capturedAt: "2026-07-20T00:00:00.000Z",
    listingEntry: { conversationId: "conv-1", title: "A branched chat", workspaces: [{ workspaceId: "ws-1" }] },
    metadata: { title: "A branched chat", createTime: "2026-01-01T00:00:00Z", projectId: "project-1" },
    responseNodes: {
      responseNodes: [
        { responseId: "r1", children: ["r2", "r3"] },
        { responseId: "r2", parentResponseId: "r1", selected: true },
        { responseId: "r3", parentResponseId: "r1", selected: false },
      ],
    },
    responseBatches: [{
      batchNumber: 1,
      requestedIds: ["r1", "r2", "r3"],
      responseHash: "fixture",
      raw: {
        responses: [
          { responseId: "r1", sender: "human", message: "Compare [these] options.", createTime: "2026-01-01T00:00:00Z" },
          {
            responseId: "r2",
            sender: "grok",
            message: "The first answer.",
            parentResponseId: "r1",
            model: "grok-test",
            citations: [{ title: "Example", url: "https://example.com/a" }],
            generatedImageUrls: ["https://assets.grok.com/image.png"],
          },
          { responseId: "r3", sender: "mystery", query: "Alternative", parentResponseId: "r1" },
        ],
      },
    }],
  };
}

describe("Grok normalization", () => {
  it("preserves branch relationships without guessing unknown roles", async () => {
    const capture = captureFixture();
    capture.discoveredWorkspaceIds = ["ws-2"];
    const { conversation, findings } = await normalizeConversation(capture);
    expect(conversation.workspaceIds).toEqual(["ws-1", "ws-2"]);
    expect(conversation.rootMessageIds).toEqual(["r1"]);
    expect(conversation.messages.map((message) => message.role)).toEqual(["user", "assistant", "unknown"]);
    expect(conversation.messages[0]?.childIds).toEqual(["r2", "r3"]);
    expect(conversation.messages[1]?.attachments[0]).toMatchObject({ kind: "image", sourceUrl: "https://assets.grok.com/image.png" });
    expect(conversation.messages[1]?.citations[0]).toMatchObject({ title: "Example", url: "https://example.com/a" });
    expect(findings).toContainEqual(expect.objectContaining({ code: "MESSAGE_ROLE_UNKNOWN", responseId: "r3" }));
  });

  it("renders deterministic Markdown with branches, sources, and attachments", async () => {
    const capture = captureFixture();
    const { conversation, findings } = await normalizeConversation(capture);
    const validation = validateConversationCapture(capture, conversation, findings);
    const markdown = renderConversationMarkdown(conversation, validation);
    expect(validation.valid).toBe(true);
    expect(markdown).toContain("## User · r1");
    expect(markdown).toContain("children: [r2](#message-r2), [r3](#message-r3)");
    expect(markdown).toContain("[Example](https://example.com/a)");
    expect(markdown).toContain("[image 1](https://assets.grok.com/image.png)");
    expect(markdown).toContain("MESSAGE_ROLE_UNKNOWN");
  });

  it("normalizes current cited web results and referenced X posts without indexing uncited search results", async () => {
    const capture = captureFixture();
    const response = (capture.responseBatches[0]!.raw as { responses: Array<Record<string, unknown>> }).responses[1]!;
    response.citedWebSearchResults = [{ title: "Cited web result", url: "https://example.com/cited" }];
    response.webSearchResults = [{ title: "Uncited web result", url: "https://example.com/uncited" }];
    response.webpageUrls = ["https://example.com/page"];
    response.xpostIds = ["1234567890"];
    response.xposts = [{ postId: "1234567890", username: "example_user", name: "Example user" }];

    const { conversation } = await normalizeConversation(capture);
    const urls = conversation.messages[1]!.citations.map((citation) => citation.url);
    expect(urls).toEqual([
      "https://example.com/a",
      "https://example.com/cited",
      "https://example.com/page",
      "https://x.com/example_user/status/1234567890",
    ]);
    expect(urls).not.toContain("https://example.com/uncited");
  });

  it("fails validation when an expected response body is missing", async () => {
    const capture = captureFixture();
    capture.responseBatches[0]!.raw = { responses: [{ responseId: "r1", sender: "human", message: "Only one" }] };
    const { conversation, findings } = await normalizeConversation(capture);
    const validation = validateConversationCapture(capture, conversation, findings);
    expect(validation.valid).toBe(false);
    expect(validation.missingResponseIds).toEqual(["r2", "r3"]);
    expect(validation.findings).toContainEqual(expect.objectContaining({ code: "RESPONSE_BODY_MISSING" }));
  });
});
