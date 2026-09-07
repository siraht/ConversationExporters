import { beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryArchiveFileSystem } from "@conversation-exporters/shared/filesystem";

let background: typeof import("../src/background");
beforeAll(async () => {
  vi.stubGlobal("chrome", {
    action: { onClicked: { addListener: vi.fn() } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() }, getPlatformInfo: vi.fn(async () => ({})) },
    alarms: { onAlarm: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
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

describe("background lifecycle", () => {
  it("keeps only the active run alive and excludes overlapping runs", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = background.runExclusive(() => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1);
    await expect(background.runExclusive(async () => undefined)).rejects.toThrow("already running");
    finish();
    await run;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it("marks unfinished runs interrupted on startup without claiming completion", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({
      "conversationExporters.activeSync": { status: "running", provider: "grok", startedAt: "2026-09-07" },
      "conversationExporters.scheduledSync": { status: "complete" },
    }));
    vi.mocked(chrome.storage.local.set).mockClear();
    await background.recoverInterruptedSync();
    expect(chrome.storage.local.set).toHaveBeenCalledExactlyOnceWith({
      "conversationExporters.activeSync": expect.objectContaining({ status: "interrupted", provider: "grok", error: expect.stringContaining("resume") }),
    });
  });
});
