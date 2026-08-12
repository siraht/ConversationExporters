import { describe, expect, it } from "vitest";
import { CaptureEngine } from "../../src/core/capture-engine";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { sha256Hex } from "../../src/core/hash";
import { parseJson } from "../../src/core/serialization";
import { DEFAULT_CAPTURE_SETTINGS, type RunJournal } from "../../src/core/types";
import { GrokClient } from "../../src/grok/client";
import { FixtureTransport } from "../fixtures/grok";

const settings = {
  ...DEFAULT_CAPTURE_SETTINGS,
  requestDelayMs: 0,
  maxRetries: 0,
  includeAssets: false,
  includeWorkspaces: false,
};

function successfulTransport(): FixtureTransport {
  return new FixtureTransport(new Map([
    ["GET /rest/app-chat/conversations?pageSize=100", [{ conversations: [
      { conversationId: "c1", title: "One", modifyTime: "2026-01-01T00:00:00Z" },
      { conversationId: "c2", title: "Two", modifyTime: "2026-01-02T00:00:00Z" },
    ] }]],
    ["GET /rest/app-chat/conversations/c1", [{ conversationId: "c1", title: "One" }]],
    ["GET /rest/app-chat/conversations/c1/response-node?includeThreads=true", [{ responseNodes: [{ responseId: "c1-r1" }] }]],
    ["POST /rest/app-chat/conversations/c1/load-responses", [{ responses: [{ responseId: "c1-r1", sender: "human", message: "One" }] }]],
    ["GET /rest/app-chat/conversations/c2", [{ conversationId: "c2", title: "Two" }]],
    ["GET /rest/app-chat/conversations/c2/response-node?includeThreads=true", [{ responseNodes: [{ responseId: "c2-r1" }] }]],
    ["POST /rest/app-chat/conversations/c2/load-responses", [{ responses: [{ responseId: "c2-r1", sender: "grok", message: "Two" }] }]],
  ]));
}

describe("capture engine", () => {
  it("writes raw, normalized, Markdown, validation, indexes, and completion markers", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const transport = successfulTransport();
    const client = new GrokClient({ transport, settings, now: () => new Date("2026-07-20T00:00:00Z") });
    const engine = new CaptureEngine({
      client,
      filesystem,
      now: () => new Date("2026-07-20T00:00:00Z"),
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });

    const summary = await engine.run();
    expect(await authoritativeHash(filesystem)).toBe("a208766de08e1c77e58b29614f7b0204e7d13ee7179ec3c426ad4f5e259b4d86");
    expect(summary).toMatchObject({ complete: true, inventoryCount: 2, completeCount: 2, failedCount: 0 });
    expect(filesystem.paths()).toContain("conversations/c1/source/response-nodes.json");
    expect(filesystem.paths()).toContain("conversations/c1/conversation.md");
    expect(filesystem.paths()).toContain("conversations/c1/complete.json");
    expect(await filesystem.readText("reports/validation.md")).toContain("Result: **COMPLETE**");
    expect((await filesystem.readText("indexes/conversations.jsonl"))?.trim().split("\n")).toHaveLength(2);
  });

  it("skips unchanged completed conversations on the next run", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const firstClient = new GrokClient({ transport: successfulTransport(), settings });
    await new CaptureEngine({
      client: firstClient,
      filesystem,
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    }).run();

    const secondTransport = new FixtureTransport(new Map([
      ["GET /rest/app-chat/conversations?pageSize=100", [{ conversations: [
        { conversationId: "c1", title: "One", modifyTime: "2026-01-01T00:00:00Z" },
        { conversationId: "c2", title: "Two", modifyTime: "2026-01-02T00:00:00Z" },
      ] }]],
    ]));
    const summary = await new CaptureEngine({
      client: new GrokClient({ transport: secondTransport, settings }),
      filesystem,
      idFactory: () => "00000000-0000-4000-8000-000000000002",
    }).run();
    expect(summary).toMatchObject({ complete: true, unchangedCount: 2 });
    expect(secondTransport.requests).toHaveLength(1);
  });

  it("retries an unchanged conversation whose asset capture was partial", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    await new CaptureEngine({
      client: new GrokClient({ transport: successfulTransport(), settings }),
      filesystem,
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    }).run();
    const path = "conversations/c1/complete.json";
    const marker = JSON.parse((await filesystem.readText(path))!);
    marker.assetStatus = "partial";
    await filesystem.writeTextAtomic(path, JSON.stringify(marker));

    const retryTransport = successfulTransport();
    const summary = await new CaptureEngine({
      client: new GrokClient({ transport: retryTransport, settings }),
      filesystem,
      idFactory: () => "00000000-0000-4000-8000-000000000002",
    }).run();
    expect(summary.unchangedCount).toBe(1);
    expect(retryTransport.requests.length).toBeGreaterThan(1);
  });

  it("does not write a completion marker when response validation fails twice", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const transport = new FixtureTransport(new Map([
      ["GET /rest/app-chat/conversations?pageSize=100", [{ conversations: [{ conversationId: "c1", title: "Broken" }] }]],
      ["GET /rest/app-chat/conversations/c1", [{}, {}]],
      ["GET /rest/app-chat/conversations/c1/response-node?includeThreads=true", [
        { responseNodes: [{ responseId: "r1" }] },
        { responseNodes: [{ responseId: "r1" }] },
      ]],
      ["POST /rest/app-chat/conversations/c1/load-responses", [{ responses: [] }, { responses: [] }]],
    ]));
    const summary = await new CaptureEngine({
      client: new GrokClient({ transport, settings }),
      filesystem,
      idFactory: () => "00000000-0000-4000-8000-000000000003",
    }).run();
    expect(summary).toMatchObject({ complete: false, failedCount: 1 });
    expect(await filesystem.exists("conversations/c1/complete.json")).toBe(false);
    const journalPath = filesystem.paths().find((path) => path.startsWith("runs/"))!;
    const journal = parseJson<RunJournal>(await filesystem.readText(journalPath));
    expect(journal?.conversations.c1?.state).toBe("terminal_failure");
  });
});

async function authoritativeHash(filesystem: MemoryArchiveFileSystem): Promise<string> {
  const paths = filesystem.paths().filter((path) => path.startsWith("conversations/") || path.startsWith("indexes/") || path.startsWith("source/"));
  const rows: string[] = [];
  for (const path of paths) rows.push(`${path}\0${await sha256Hex((await filesystem.readBytes(path))!)}`);
  return sha256Hex(rows.sort().join("\n"));
}
