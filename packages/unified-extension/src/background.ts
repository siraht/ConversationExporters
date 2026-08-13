import type { ArchiveFileSystem } from "@conversation-exporters/shared/filesystem";
import { findProviderTab, isTrustedExtensionSender, sendPageRequest } from "@conversation-exporters/shared/extension-runtime";
import { sha256Hex } from "@conversation-exporters/shared/hash";
import { IndexedDbArchiveFileSystem, listBrowserArchiveEntries } from "@conversation-exporters/shared/indexeddb-filesystem";
import { NativeArchiveFileSystem, type NativeArchiveNamespace } from "@conversation-exporters/shared/native-filesystem";
import { validateOperation } from "../../chatgpt-exporter/src/chatgpt/endpoints";
import { failureResponse, parseApiRequest, requestId, type ApiResponse } from "../../chatgpt-exporter/src/extension/protocol";
import { isAllowedGrokApiRequest } from "../../grok-exporter/src/grok/endpoints";
import { BRIDGE_PROTOCOL_VERSION, type ApiResponse as GrokApiResponse } from "../../grok-exporter/src/core/types";
import { isApiRequest, type RuntimeApiRequest } from "../../grok-exporter/src/extension/protocol";
import type { PageReply, PageRequest } from "../../web-sync-exporter/src/protocol";
import type { DirectProvider, StorageSettings, SyncSummary } from "./types";
import { syncFilesystem, testVps } from "./vps";

type JsonRecord = Record<string, unknown>;
const SETTINGS_KEY = "conversationExporters.unifiedStorage";
const ARCHIVES: NativeArchiveNamespace[] = ["chatgpt-web", "claude-web", "gemini-web", "google-ai-studio", "grok-web"];
let active: Promise<unknown> | undefined;

chrome.action.onClicked.addListener(() => { void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create("conversation-exporter-sync", { periodInMinutes: 60 }); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "conversation-exporter-sync") void runExclusive(syncAll).catch(() => undefined); });

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender)) return false;
  const value = message as Record<string, unknown>;
  if (value.type === "CHATGPT_EXPORTER_FIND_TAB") { void findProviderTab(["https://chatgpt.com/*"], "Open and sign in to ChatGPT, then retry.").then(sendResponse); return true; }
  if (value.type === "CHATGPT_EXPORTER_API_REQUEST") { void chatGptRequest(value.tabId, value.request).then(sendResponse); return true; }
  if (value.type === "GROK_EXPORTER_FIND_TAB") { void findProviderTab(["https://grok.com/*"], "Open and sign in to Grok, then retry.").then(sendResponse); return true; }
  if (value.type === "GROK_EXPORTER_API_REQUEST") { void grokRequest(value as unknown as RuntimeApiRequest).then(sendResponse); return true; }
  if (value.type === "UNIFIED_SYNC_PROVIDER") { respond(runExclusive(() => syncProvider(value.provider as DirectProvider)), sendResponse); return true; }
  if (value.type === "UNIFIED_GET_SETTINGS") { respond(publicSettings(), sendResponse, "settings"); return true; }
  if (value.type === "UNIFIED_SAVE_SETTINGS") { respond(saveSettings(value.settings), sendResponse); return true; }
  if (value.type === "UNIFIED_ARCHIVE_STATUS") { respond(archiveStatus(), sendResponse); return true; }
  if (value.type === "UNIFIED_SYNC_STORAGE") { respond(runExclusive(syncStorage), sendResponse); return true; }
  if (value.type === "UNIFIED_ARCHIVE_CHANGED" || value.type === "UNIFIED_VPS_SYNC") { respond(syncArchive(value.namespace as NativeArchiveNamespace), sendResponse); return true; }
  return false;
});

function respond<T>(promise: Promise<T>, sendResponse: (response: unknown) => void, key = "result"): void {
  void promise.then((result) => sendResponse({ ok: true, [key]: result }), (error) => sendResponse({ ok: false, error: messageOf(error) }));
}

async function loadSettings(): Promise<StorageSettings> {
  const value = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<StorageSettings> | undefined;
  return {
    vpsEnabled: value?.vpsEnabled === true,
    vpsBaseUrl: String(value?.vpsBaseUrl ?? "").replace(/\/+$/, ""),
    vpsToken: String(value?.vpsToken ?? ""),
    nativeEnabled: value?.nativeEnabled === true,
  };
}

async function publicSettings(): Promise<{ vpsEnabled: boolean; vpsBaseUrl: string; nativeEnabled: boolean; tokenConfigured: boolean }> {
  const settings = await loadSettings();
  return { vpsEnabled: settings.vpsEnabled, vpsBaseUrl: settings.vpsBaseUrl, nativeEnabled: settings.nativeEnabled, tokenConfigured: Boolean(settings.vpsToken) };
}

async function saveSettings(raw: unknown): Promise<void> {
  const candidate = raw as Partial<StorageSettings> | undefined;
  const previous = await loadSettings();
  const settings: StorageSettings = {
    vpsEnabled: candidate?.vpsEnabled === true,
    vpsBaseUrl: String(candidate?.vpsBaseUrl ?? "").replace(/\/+$/, ""),
    vpsToken: String(candidate?.vpsToken || previous.vpsToken || ""),
    nativeEnabled: candidate?.nativeEnabled === true,
  };
  if (settings.vpsEnabled) await testVps({ enabled: true, baseUrl: settings.vpsBaseUrl, token: settings.vpsToken });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function archiveStatus(): Promise<Array<{ namespace: string; files: number; bytes: number }>> {
  const totals = new Map<string, { files: number; bytes: number }>();
  for (const entry of await listBrowserArchiveEntries()) {
    const total = totals.get(entry.namespace) ?? { files: 0, bytes: 0 };
    total.files += 1; total.bytes += entry.blob.size; totals.set(entry.namespace, total);
  }
  return [...totals].map(([namespace, total]) => ({ namespace, ...total })).sort((a, b) => a.namespace.localeCompare(b.namespace));
}

async function syncStorage(): Promise<{ vpsFiles: number; nativeFiles: number; failed: number }> {
  let vpsFiles = 0, nativeFiles = 0, failed = 0;
  for (const namespace of ARCHIVES) {
    const result = await syncArchive(namespace);
    vpsFiles += result.vpsFiles; nativeFiles += result.nativeFiles; failed += result.failed;
  }
  if (failed) throw new Error(`${failed} archive file${failed === 1 ? "" : "s"} could not be replicated; the browser copies are intact.`);
  return { vpsFiles, nativeFiles, failed };
}

async function syncArchive(namespace: NativeArchiveNamespace): Promise<{ vpsFiles: number; nativeFiles: number; failed: number }> {
  if (!ARCHIVES.includes(namespace)) throw new Error("Unknown archive namespace");
  const settings = await loadSettings();
  const browser = new IndexedDbArchiveFileSystem(namespace);
  let vpsFiles = 0, nativeFiles = 0, failed = 0;
  if (settings.vpsEnabled) {
    const result = await syncFilesystem(namespace, browser, { enabled: true, baseUrl: settings.vpsBaseUrl, token: settings.vpsToken });
    vpsFiles = result.uploaded; failed += result.failed;
  }
  if (settings.nativeEnabled) {
    const result = await mirrorToNative(namespace, browser);
    nativeFiles = result.changed; failed += result.failed;
  }
  return { vpsFiles, nativeFiles, failed };
}

async function mirrorToNative(namespace: NativeArchiveNamespace, browser: ArchiveFileSystem): Promise<{ changed: number; failed: number }> {
  const native = new NativeArchiveFileSystem(namespace);
  const stateKey = `conversationExporters.nativeState.${namespace}`;
  const state = ((await chrome.storage.local.get(stateKey))[stateKey] ?? {}) as Record<string, string>;
  let changed = 0, failed = 0;
  for (const path of await browser.listPaths()) {
    const bytes = await browser.readBytes(path); if (!bytes) continue;
    const hash = await sha256Hex(bytes); if (state[path] === hash) continue;
    try { await native.writeBytesAtomic(path, bytes); state[path] = hash; changed += 1; await chrome.storage.local.set({ [stateKey]: state }); }
    catch { failed += 1; }
  }
  return { changed, failed };
}

async function chatGptRequest(tabId: unknown, raw: unknown): Promise<ApiResponse> {
  let request; try { request = parseApiRequest(raw); validateOperation(request); if (!Number.isInteger(tabId)) throw new Error(); }
  catch { return failureResponse(requestId(raw), "INVALID_BRIDGE_REQUEST", "Request failed extension validation."); }
  try { return await sendPageRequest<ApiResponse>(tabId as number, "CHATGPT_EXPORTER_PAGE_REQUEST", request); }
  catch { return failureResponse(request.requestId, "CHATGPT_TAB_UNREACHABLE", "Reload ChatGPT and retry.", { retryable: true }); }
}

async function grokRequest(message: RuntimeApiRequest): Promise<GrokApiResponse> {
  if (!Number.isInteger(message.tabId) || !isApiRequest(message.request) || !isAllowedGrokApiRequest(message.request.path, message.request.method)) return { requestId: isApiRequest(message.request) ? message.request.requestId : "unknown", protocolVersion: BRIDGE_PROTOCOL_VERSION, ok: false, error: { name: "ServiceWorkerError", message: "Request failed extension validation.", code: "INVALID_BRIDGE_REQUEST", retryable: false } };
  try { return await sendPageRequest<GrokApiResponse>(message.tabId, "GROK_EXPORTER_PAGE_REQUEST", message.request); }
  catch { return { requestId: message.request.requestId, protocolVersion: BRIDGE_PROTOCOL_VERSION, ok: false, error: { name: "ServiceWorkerError", message: "Reload Grok and retry.", code: "GROK_TAB_UNREACHABLE", retryable: true } }; }
}

async function syncAll(): Promise<Record<string, SyncSummary | { error: string }>> {
  const output: Record<string, SyncSummary | { error: string }> = {};
  for (const provider of ["claude", "gemini", "ai-studio"] as const) {
    try { output[provider] = await syncProvider(provider); } catch (error) { output[provider] = { error: messageOf(error) }; }
  }
  return output;
}

async function syncProvider(provider: DirectProvider): Promise<SyncSummary> {
  if (!["claude", "gemini", "ai-studio"].includes(provider)) throw new Error("Unknown provider");
  const namespace: NativeArchiveNamespace = provider === "claude" ? "claude-web" : provider === "gemini" ? "gemini-web" : "google-ai-studio";
  const filesystem = new IndexedDbArchiveFileSystem(namespace);
  try {
    const summary = provider === "claude" ? await syncClaude(filesystem) : provider === "gemini" ? await syncGemini(filesystem) : await syncAiStudio(filesystem);
    await filesystem.writeTextAtomic("sync-report.json", JSON.stringify({ schemaVersion: 1, provider, status: summary.failed ? "partial" : "complete", completedAt: new Date().toISOString(), summary }));
    await syncArchive(namespace).catch(() => undefined);
    return summary;
  } catch (error) {
    await filesystem.writeTextAtomic("sync-report.json", JSON.stringify({ schemaVersion: 1, provider, status: "failed", completedAt: new Date().toISOString(), error: messageOf(error) })).catch(() => undefined);
    throw error;
  }
}

async function syncClaude(filesystem: ArchiveFileSystem): Promise<SyncSummary> {
  const listing = asRecords(await pageRequest("https://claude.ai/*", "claudeList"));
  const previous = new Map((await readJson<JsonRecord[]>(filesystem, "conversations.json", [])).flatMap((row) => typeof row.uuid === "string" ? [[row.uuid, row] as const] : []));
  const output: JsonRecord[] = []; let fetched = 0, unchanged = 0;
  for (const row of listing) {
    const id = text(row.uuid), organizationId = text(row._organization_uuid); if (!id || !organizationId) continue;
    const prior = previous.get(id);
    if (prior && prior.updated_at === row.updated_at) { output.push(prior); previous.delete(id); unchanged += 1; continue; }
    output.push({ ...asRecord(await pageRequest("https://claude.ai/*", "claudeDetail", { organizationId, conversationId: id })), _organization_uuid: organizationId });
    previous.delete(id); fetched += 1; await delay(150);
  }
  const retained = previous.size; output.push(...previous.values()); output.sort(by("uuid"));
  await filesystem.writeTextAtomic("conversations.json", JSON.stringify(output));
  return { provider: "claude", discovered: listing.length, fetched, unchanged, retained, failed: 0 };
}

async function syncGemini(filesystem: ArchiveFileSystem): Promise<SyncSummary> {
  const listing = asRecords(await pageRequest("https://gemini.google.com/*", "geminiList"));
  const document = await readJson<{ conversations: JsonRecord[] }>(filesystem, "conversations.json", { conversations: [] });
  const previous = new Map(document.conversations.flatMap((row) => typeof row.id === "string" ? [[row.id, row] as const] : []));
  const output: JsonRecord[] = []; let fetched = 0, unchanged = 0, failed = 0;
  for (const row of listing) {
    const id = text(row.id); if (!id) continue; const prior = previous.get(id);
    if (prior && prior.updated_at === row.updated_at) { output.push(prior); previous.delete(id); unchanged += 1; continue; }
    try {
      const detail = asRecord(await pageRequest("https://gemini.google.com/*", "geminiDetail", { conversationId: id }));
      if (!Array.isArray(detail.messages) || !detail.messages.length) throw new Error("Gemini rendered no messages for a listed conversation");
      output.push({ ...row, ...detail }); previous.delete(id); fetched += 1;
    } catch { failed += 1; if (prior) { output.push(prior); previous.delete(id); } }
    await delay(250);
  }
  const retained = previous.size; output.push(...previous.values()); output.sort(by("id"));
  await filesystem.writeTextAtomic("conversations.json", JSON.stringify({ conversations: output }));
  return { provider: "gemini", discovered: listing.length, fetched, unchanged, retained, failed };
}

async function syncAiStudio(filesystem: ArchiveFileSystem): Promise<SyncSummary> {
  const prompts = asRecords(await pageRequest("https://aistudio.google.com/*", "aiStudioList"));
  const prior = await readJson<{ prompts: JsonRecord[] }>(filesystem, "prompts.json", { prompts: [] });
  const previous = new Map(prior.prompts.flatMap((row) => typeof row.id === "string" ? [[row.id, row] as const] : []));
  const output: JsonRecord[] = []; let fetched = 0, unchanged = 0;
  for (const raw of prompts) {
    const id = text(raw.id); if (!id || !Array.isArray(raw.inventory) || !("detail" in raw)) continue;
    const hash = await sha256Hex(JSON.stringify({ inventory: raw.inventory, detail: raw.detail })); const old = previous.get(id);
    if (old?.hash === hash) { output.push(old); unchanged += 1; }
    else { const metadata = Array.isArray(raw.inventory[4]) ? raw.inventory[4] : []; output.push({ id, title: text(metadata[0]) || text(metadata[1]) || "Untitled", hash, inventory: raw.inventory, detail: raw.detail }); fetched += 1; }
    previous.delete(id);
  }
  const retained = previous.size; output.push(...previous.values()); output.sort(by("id"));
  await filesystem.writeTextAtomic("prompts.json", JSON.stringify({ schema: "conversation-exporters/ai-studio-web/2", prompts: output }));
  return { provider: "ai-studio", discovered: prompts.length, fetched, unchanged, retained, failed: 0 };
}

async function pageRequest(pattern: string, operation: PageRequest["operation"], parameters?: Record<string, unknown>): Promise<unknown> {
  const tabs = await chrome.tabs.query({ url: pattern }); const tab = tabs.find((item) => item.id !== undefined);
  if (!tab?.id) throw new Error(`Open a signed-in ${new URL(pattern.replace("*", "")).hostname} tab`);
  const request: PageRequest = { type: "WEB_SYNC_PAGE_REQUEST", requestId: crypto.randomUUID(), operation, ...(parameters ? { parameters } : {}) };
  const reply = await chrome.tabs.sendMessage<PageRequest, PageReply>(tab.id, request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Provider tab did not answer"); return reply.result;
}

async function readJson<T>(filesystem: ArchiveFileSystem, path: string, fallback: T): Promise<T> { const value = await filesystem.readText(path); return value ? JSON.parse(value) as T : fallback; }
function asRecords(value: unknown): JsonRecord[] { if (!Array.isArray(value)) throw new Error("Provider inventory was malformed"); return value.filter((row): row is JsonRecord => Boolean(row) && typeof row === "object"); }
function asRecord(value: unknown): JsonRecord { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider detail was malformed"); return value as JsonRecord; }
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function by(key: string) { return (a: JsonRecord, b: JsonRecord) => String(a[key] ?? "").localeCompare(String(b[key] ?? "")); }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function runExclusive<T>(operation: () => Promise<T>): Promise<T> { if (active) throw new Error("A sync is already running"); const promise = operation(); active = promise; try { return await promise; } finally { active = undefined; } }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Operation failed"; }
