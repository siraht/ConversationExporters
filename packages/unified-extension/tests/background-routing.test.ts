import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryArchiveFileSystem } from "@conversation-exporters/shared/filesystem";
import type { ManagedSyncDependencies } from "../src/managed-sync";

const state = vi.hoisted(() => ({ storage: {} as Record<string, unknown>, files: new Map<string, MemoryArchiveFileSystem>() }));
vi.mock("@conversation-exporters/shared/indexeddb-filesystem", async () => {
  const { MemoryArchiveFileSystem } = await import("@conversation-exporters/shared/filesystem");
  return {
    IndexedDbArchiveFileSystem: class extends MemoryArchiveFileSystem {
      constructor(namespace: string) { super(); const existing = state.files.get(namespace); if (existing) return existing; state.files.set(namespace, this); }
    },
    listBrowserArchiveEntries: async () => [],
  };
});
vi.mock("../src/managed-sync", () => ({
  syncManagedChatGpt: vi.fn(async (_report, _cancel, dependencies: ManagedSyncDependencies) => {
    await dependencies.chatGptTransport(1).request({ operation: "accounts_list", parameters: {} }, null);
    return { provider: "chatgpt", discovered: 0, fetched: 0, unchanged: 0, retained: 0, failed: 0 };
  }),
  syncManagedGrok: vi.fn(async (_report, _cancel, dependencies: ManagedSyncDependencies) => {
    const tab = await dependencies.findGrokTab();
    await dependencies.grokTransport(tab.tabId!).request({ path: "/rest/app-chat/conversations", method: "GET", timeoutMs: 30000 });
    return { provider: "grok", discovered: 0, fetched: 0, unchanged: 0, retained: 0, failed: 0 };
  }),
}));

let background: typeof import("../src/background");
let listener: (message: unknown, sender: chrome.runtime.MessageSender, response: (value: unknown) => void) => unknown;
beforeAll(async () => {
  vi.stubGlobal("chrome", {
    action: { onClicked: { addListener: vi.fn() } },
    runtime: { id: "test", getURL: () => "moz-extension://test/", onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: (value: typeof listener) => { listener = value; } }, sendMessage: vi.fn(), getPlatformInfo: vi.fn(async () => ({})) },
    alarms: { onAlarm: { addListener: vi.fn() }, get: vi.fn(async () => undefined), create: vi.fn(async () => undefined) },
    storage: { local: { get: vi.fn(async () => ({ ...state.storage })), set: vi.fn(async (values) => { Object.assign(state.storage, values); }) } },
    tabs: { query: vi.fn(async () => [{ id: 1 }]), sendMessage: vi.fn(async (_id, message) => {
      if (message.type !== "WEB_SYNC_PAGE_REQUEST_V2") return { ok: true, data: {} };
      return { ok: true, result: message.operation === "geminiAccount" ? {} : message.operation === "geminiGems" ? { gems: [] } : [] };
    }) },
  });
  background = await import("../src/background");
});

function dispatch(provider: string): Promise<unknown> {
  return new Promise((resolve) => listener({ type: "UNIFIED_SYNC_PROVIDER", provider }, { id: "test", url: "moz-extension://test/dashboard.html" }, resolve));
}

describe("background provider routing", () => {
  it("owns the entire manual all-provider run without dashboard orchestration", async () => {
    const response = await new Promise((resolve) => listener({ type: "UNIFIED_SYNC_ALL" }, { id: "test", url: "moz-extension://test/dashboard.html" }, resolve));
    expect(response).toMatchObject({ ok: true, result: {
      claude: { failed: 0 }, gemini: { failed: 0 }, "ai-studio": { failed: 0 }, chatgpt: { failed: 0 }, grok: { failed: 0 },
    } });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("runs ChatGPT and Grok manually through injected page transports", async () => {
    for (const provider of ["chatgpt", "grok"]) {
      expect(await dispatch(provider)).toMatchObject({ ok: true, result: { provider, failed: 0 } });
      const report = JSON.parse((await state.files.get(`${provider}-web`)!.readText("sync-report.json"))!);
      expect(report).toMatchObject({ provider, status: "complete" });
    }
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: "CHATGPT_EXPORTER_PAGE_REQUEST" }));
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: "GROK_EXPORTER_PAGE_REQUEST" }));
  });

  it("schedules all five providers and restores a missing hourly alarm", async () => {
    await background.runScheduledSync();
    expect(state.storage["conversationExporters.scheduledSync"]).toMatchObject({ status: "complete", results: {
      claude: { failed: 0 }, gemini: { failed: 0 }, "ai-studio": { failed: 0 }, chatgpt: { failed: 0 }, grok: { failed: 0 },
    } });
    expect(chrome.alarms.create).toHaveBeenCalledWith("conversation-exporter-sync", { periodInMinutes: 60 });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("invalidates the root archive report when a prior run was interrupted", async () => {
    state.storage["conversationExporters.activeSync"] = { provider: "grok", status: "running" };
    await background.recoverInterruptedSync();
    expect(state.storage["conversationExporters.activeSync"]).toMatchObject({ status: "interrupted" });
    const filesystem = state.files.get("grok-web")!;
    expect(JSON.parse((await filesystem.readText("sync-report.json"))!)).toMatchObject({ status: "interrupted" });
    expect(JSON.parse((await filesystem.readText("validation.json"))!)).toMatchObject({ valid: false });
  });
});
