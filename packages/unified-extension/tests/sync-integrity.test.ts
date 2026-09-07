import { beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryArchiveFileSystem } from "@conversation-exporters/shared/filesystem";

let background: typeof import("../src/background");
beforeAll(async () => {
  vi.stubGlobal("chrome", {
    action: { onClicked: { addListener: vi.fn() } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() } },
    alarms: { onAlarm: { addListener: vi.fn() } },
  });
  background = await import("../src/background");
});

describe("archive completeness reconciliation", () => {
  it("rejects equal counts belonging to different IDs", async () => {
    const fs = new MemoryArchiveFileSystem();
    await fs.writeTextAtomic("conversations/old/complete.json", "{}");
    expect(await background.writeValidation(fs, "claude", ["new"], "conversations")).toBe(false);
    expect(JSON.parse((await fs.readText("validation.json"))!)).toMatchObject({ complete: 0, retained: 1, missingIds: ["new"] });
  });

  it("preserves historical records without letting them invalidate a successful current inventory", async () => {
    const fs = new MemoryArchiveFileSystem();
    await fs.writeTextAtomic("conversations/old/complete.json", "{}");
    await fs.writeTextAtomic("conversations/old/error.json", "{}");
    await fs.writeTextAtomic("conversations/current/complete.json", "{}");
    expect(await background.writeValidation(fs, "gemini", ["current"], "conversations")).toBe(true);
    expect(await fs.exists("conversations/old/complete.json")).toBe(true);
  });

  it("rejects an old completion marker when the current fetch failed", async () => {
    const fs = new MemoryArchiveFileSystem();
    await fs.writeTextAtomic("prompts/current/complete.json", "{}");
    await fs.writeTextAtomic("prompts/current/error.json", "{}");
    expect(await background.writeValidation(fs, "ai-studio", ["current"], "prompts")).toBe(false);
    expect(JSON.parse((await fs.readText("validation.json"))!)).toMatchObject({ complete: 0, failedIds: ["current"] });
  });

  it("rejects missing, duplicate, and colliding identifiers", async () => {
    const fs = new MemoryArchiveFileSystem();
    await fs.writeTextAtomic("prompts/a-b/complete.json", "{}");
    for (const ids of [[undefined], ["a-b", "a-b"], ["a/b", "a-b"]]) {
      expect(await background.writeValidation(fs, "ai-studio", ids, "prompts")).toBe(false);
    }
  });

  it("includes ancillary project or asset failures in the result", async () => {
    const fs = new MemoryArchiveFileSystem();
    expect(await background.writeValidation(fs, "claude", [], "conversations", 1)).toBe(false);
  });
});

describe("timestamp freshness", () => {
  it("never treats missing or malformed timestamps as unchanged", () => {
    for (const timestamp of [undefined, null, "", "not-a-date", 0, NaN]) {
      expect(background.hasMatchingTimestamp(timestamp, timestamp)).toBe(false);
    }
  });
  it("only skips when valid source timestamps agree", () => {
    expect(background.hasMatchingTimestamp("2026-09-07T12:00:00Z", "2026-09-07T12:00:00Z")).toBe(true);
    expect(background.hasMatchingTimestamp(1788800000, 1788800000)).toBe(true);
    expect(background.hasMatchingTimestamp(1788800000, 1788800001)).toBe(false);
  });
});
