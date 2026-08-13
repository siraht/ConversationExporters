import { IndexedDbArchiveFileSystem } from "@conversation-exporters/shared/indexeddb-filesystem";
import { auditArchive } from "../../chatgpt-exporter/src/chatgpt/audit";
import { ChatGptCaptureEngine } from "../../chatgpt-exporter/src/chatgpt/capture-engine";
import { ChatGptClient } from "../../chatgpt-exporter/src/chatgpt/client";
import { DEFAULT_INVENTORY_SETTINGS, runWorkspaceInventories } from "../../chatgpt-exporter/src/chatgpt/inventory";
import { ControlledTransport } from "../../chatgpt-exporter/src/core/request-control";
import { RuntimeApiTransport as ChatGptTransport } from "../../chatgpt-exporter/src/extension/protocol";
import { CaptureEngine as GrokCaptureEngine } from "../../grok-exporter/src/core/capture-engine";
import { RunControl } from "../../grok-exporter/src/core/control";
import { DEFAULT_CAPTURE_SETTINGS, type ProgressEvent } from "../../grok-exporter/src/core/types";
import { GrokClient } from "../../grok-exporter/src/grok/client";
import { BrowserAssetFetcher } from "../../grok-exporter/src/extension/asset-fetcher";
import { RuntimeApiTransport as GrokTransport, type FindTabResult as GrokFindTabResult } from "../../grok-exporter/src/extension/protocol";
import type { SyncSummary } from "./types";

export type ProgressReporter = (message: string) => void;
export type CancellationRegistrar = (cancel: (() => void) | null) => void;

export async function syncManagedGrok(report: ProgressReporter, registerCancellation: CancellationRegistrar): Promise<SyncSummary> {
  const tab = await chrome.runtime.sendMessage<{ type: "GROK_EXPORTER_FIND_TAB" }, GrokFindTabResult>({ type: "GROK_EXPORTER_FIND_TAB" });
  if (!tab.ok || tab.tabId === undefined) throw new Error(tab.error ?? "Open a signed-in Grok tab, then retry.");
  const control = new RunControl();
  registerCancellation(() => control.cancel());
  const filesystem = new IndexedDbArchiveFileSystem("grok-web");
  await filesystem.ready();
  try {
    const client = new GrokClient({
      transport: new GrokTransport(tab.tabId),
      settings: DEFAULT_CAPTURE_SETTINGS,
      cancellation: control,
      onProgress: (event: ProgressEvent) => report(`Grok · ${event.message}`),
    });
    const result = await new GrokCaptureEngine({
      client,
      filesystem,
      cancellation: control,
      onProgress: (event) => report(`Grok · ${event.message}`),
      assetFetcher: new BrowserAssetFetcher(),
    }).run();
    await chrome.runtime.sendMessage({ type: "UNIFIED_ARCHIVE_CHANGED", namespace: "grok-web" });
    return {
      provider: "grok",
      discovered: result.inventoryCount,
      fetched: Math.max(0, result.completeCount - result.unchangedCount),
      unchanged: result.unchangedCount,
      retained: result.missingRemoteConversationIds.length,
      failed: result.failedCount,
    };
  } finally { registerCancellation(null); }
}

export async function syncManagedChatGpt(report: ProgressReporter, registerCancellation: CancellationRegistrar): Promise<SyncSummary> {
  report("ChatGPT · Finding accessible workspaces…");
  const tabs = (await chrome.tabs.query({ url: "https://chatgpt.com/*" }))
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
  if (!tabs.length) throw new Error("Open a signed-in ChatGPT tab, then retry.");
  let runtime: ChatGptTransport | undefined;
  let client: ChatGptClient | undefined;
  let discovered: Awaited<ReturnType<ChatGptClient["discoverWorkspaces"]>> = [];
  let lastError: unknown;
  for (const tab of tabs) {
    try {
      const candidateRuntime = new ChatGptTransport(tab.id);
      const candidateClient = new ChatGptClient(candidateRuntime);
      const candidateWorkspaces = (await candidateClient.discoverWorkspaces()).filter((workspace) => !workspace.deactivated);
      runtime = candidateRuntime;
      client = candidateClient;
      discovered = candidateWorkspaces;
      break;
    } catch (error) { lastError = error; }
  }
  if (!runtime || !client) throw lastError ?? new Error("Reload a signed-in ChatGPT tab, then retry.");
  if (!discovered.length) throw new Error("ChatGPT returned no active accessible workspaces.");
  const workspaces = [];
  for (const workspace of discovered) {
    report(`ChatGPT · Verifying ${workspace.label}…`);
    workspaces.push((await client.preflight(workspace)).workspace);
  }
  const controlled = new ControlledTransport(runtime, { delayMs: 250, maxConcurrency: 1 });
  registerCancellation(() => controlled.cancel());
  try {
    const targets = await Promise.all(workspaces.map(async (workspace) => {
      const filesystem = new IndexedDbArchiveFileSystem("chatgpt-web", `ChatGPTExport-${workspace.workspaceFingerprint}`);
      await filesystem.ready();
      return { workspace, filesystem };
    }));
    const inventories = await runWorkspaceInventories({
      transport: controlled,
      targets,
      settings: DEFAULT_INVENTORY_SETTINGS,
      onProgress: (fingerprint, progress) => report(`ChatGPT · Inventory ${fingerprint.slice(0, 8)} · page ${progress.pageNumber} · ${progress.uniqueConversations} found`),
    });
    const inventoryCount = [...inventories.values()].reduce((sum, inventory) => sum + inventory.conversations.length, 0);
    let fetched = 0, rebuilt = 0, unchanged = 0, failed = 0;
    for (const { workspace, filesystem } of targets) {
      const result = await new ChatGptCaptureEngine({
        transport: controlled,
        filesystem,
        workspace,
        runId: `capture-${Date.now()}-${crypto.randomUUID()}`,
        batchSize: 10,
        includeAssets: true,
        includeAccountArtifacts: true,
        onProgress: (progress) => report(`ChatGPT · ${workspace.label} · ${progress.completed}/${progress.total} ${progress.phase}`),
      }).run();
      fetched += result.capturedCount;
      rebuilt += result.rebuiltCount;
      unchanged += result.skippedCount;
      failed += result.failedCount;
      report(`ChatGPT · Validating ${workspace.label}…`);
      await auditArchive({ filesystem, extensionVersion: chrome.runtime.getManifest().version });
    }
    await chrome.runtime.sendMessage({ type: "UNIFIED_ARCHIVE_CHANGED", namespace: "chatgpt-web" });
    return { provider: "chatgpt", discovered: inventoryCount, fetched: fetched + rebuilt, unchanged, retained: 0, failed };
  } finally { registerCancellation(null); }
}
