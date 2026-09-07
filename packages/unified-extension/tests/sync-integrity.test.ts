import { beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryArchiveFileSystem } from "@conversation-exporters/shared/filesystem";

let background: typeof import("../src/background");
beforeAll(async () => {
  vi.stubGlobal("chrome", {
    action: { onClicked: { addListener: vi.fn() } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() }, getPlatformInfo: vi.fn(async () => ({})) },
    alarms: { onAlarm: { addListener: vi.fn() }, get: vi.fn(async () => ({})), create: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  });
  background = await import("../src/background");
});

describe("archive completeness reconciliation", () => {
  it("retains truncated refresh payloads without overwriting the prior conversation", async () => {
    const fs = new MemoryArchiveFileSystem();
    await fs.writeTextAtomic("conversations/chat/conversation.json", "previous full record");
    await expect(background.preserveTruncatedAttempt(fs, "conversations/chat", { possibly_truncated: true, messages: [] })).rejects.toThrow("turn limit");
    expect(await fs.readText("conversations/chat/conversation.json")).toBe("previous full record");
    expect(JSON.parse((await fs.readText("conversations/chat/truncated-attempt.json"))!)).toMatchObject({ possibly_truncated: true });
  });
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
  it("refreshes legacy captures once and retries degraded captures", async () => {
    const fs = new MemoryArchiveFileSystem();
    const stamp = "2026-09-07T12:00:00Z";
    await fs.writeTextAtomic("conversations/a/complete.json", "{\"schemaVersion\":1}");
    expect(await background.canSkipCapture(fs, "conversations/a", stamp, stamp)).toBe(false);
    await fs.writeTextAtomic("conversations/a/complete.json", "{\"captureVersion\":2}");
    expect(await background.canSkipCapture(fs, "conversations/a", stamp, stamp)).toBe(true);
    await fs.writeTextAtomic("conversations/a/incomplete.json", "{}");
    expect(await background.canSkipCapture(fs, "conversations/a", stamp, stamp)).toBe(false);
  });
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
  it("runs three independent provider slots while keeping queued work bounded", async () => {
    let running = 0, maximum = 0;
    const finished: number[] = [];
    await background.forEachConcurrent([1, 2, 3, 4, 5], 3, async (provider) => {
      running += 1; maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      finished.push(provider); running -= 1;
    });
    expect(maximum).toBe(3);
    expect(finished.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(running).toBe(0);
  });
  it("drains in-flight workers before releasing a failed concurrent sync", async () => {
    let finish!: () => void;
    let settled = false;
    const operation = background.forEachConcurrent([1, 2, 3], 2, async (value) => {
      if (value === 1) throw new Error("cancelled");
      await new Promise<void>((resolve) => { finish = resolve; });
    }).catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await operation;
    expect(settled).toBe(true);
  });
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
});
