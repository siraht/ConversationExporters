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
  const organizations = asRecords(await pageRequest("https://claude.ai/*", "claudeAccount"));
  await writeJson(filesystem, "source/organizations.json", organizations);
  const listing = asRecords(await pageRequest("https://claude.ai/*", "claudeList"));
  await writeJson(filesystem, "inventory.json", { schema: "conversation-exporters/claude-web/3", organizations, conversations: listing });
  let fetched = 0, unchanged = 0, failed = 0;

  for (const organization of organizations) {
    const organizationId = text(organization.uuid); if (!organizationId) continue;
    const orgRoot = `organizations/${pathSegment(organizationId)}`;
    await writeJson(filesystem, `${orgRoot}/organization.json`, organization);
    if (Array.isArray(organization.capabilities) && !organization.capabilities.includes("chat")) {
      await removeIfExists(filesystem, `${orgRoot}/projects/error.json`);
      continue;
    }
    try {
      const projects = asRecords(await pageRequest("https://claude.ai/*", "claudeProjects", { organizationId }));
      await writeJson(filesystem, `${orgRoot}/projects/index.json`, projects);
      for (const project of projects) {
        const projectId = text(project.uuid) ?? text(project.id); if (!projectId) continue;
        const projectRoot = `${orgRoot}/projects/${pathSegment(projectId)}`;
        try {
          const [detail, docs, conversations] = await Promise.all([
            pageRequest("https://claude.ai/*", "claudeProjectDetail", { organizationId, projectId }),
            pageRequest("https://claude.ai/*", "claudeProjectDocs", { organizationId, projectId }),
            pageRequest("https://claude.ai/*", "claudeProjectConversations", { organizationId, projectId }),
          ]);
          await writeJson(filesystem, `${projectRoot}/project.json`, detail);
          await writeJson(filesystem, `${projectRoot}/docs.json`, docs);
          await writeJson(filesystem, `${projectRoot}/conversations.json`, conversations);
          const instructions = text(asRecordOrEmpty(detail).prompt_template);
          if (instructions) await filesystem.writeTextAtomic(`${projectRoot}/instructions.md`, instructions);
          for (const [index, doc] of asRecordsOrEmpty(docs).entries()) {
            await writeJson(filesystem, `${projectRoot}/docs/${String(index + 1).padStart(4, "0")}-${pathSegment(text(doc.uuid) ?? text(doc.id) ?? "document")}.json`, doc);
            if (typeof doc.content === "string") await filesystem.writeTextAtomic(`${projectRoot}/docs/${String(index + 1).padStart(4, "0")}-${pathSegment(text(doc.name) ?? text(doc.file_name) ?? "document")}.content`, doc.content);
          }
          await writeJson(filesystem, `${projectRoot}/complete.json`, { schemaVersion: 1, completedAt: new Date().toISOString(), docs: asRecordsOrEmpty(docs).length, conversations: asRecordsOrEmpty(conversations).length });
          await removeIfExists(filesystem, `${projectRoot}/error.json`);
        } catch (error) {
          failed += 1;
          await writeJson(filesystem, `${projectRoot}/error.json`, { error: messageOf(error), failedAt: new Date().toISOString() });
        }
      }
    } catch (error) {
      failed += 1;
      await writeJson(filesystem, `${orgRoot}/projects/error.json`, { error: messageOf(error), failedAt: new Date().toISOString() });
    }
  }

  for (const row of listing) {
    const id = text(row.uuid), organizationId = text(row._organization_uuid); if (!id || !organizationId) continue;
    const root = `conversations/${pathSegment(id)}`;
    const prior = await readJson<JsonRecord>(filesystem, `${root}/metadata.json`, {});
    if (prior.updated_at === row.updated_at && await filesystem.exists(`${root}/complete.json`)) { unchanged += 1; continue; }
    try {
      const detail = { ...asRecord(await pageRequest("https://claude.ai/*", "claudeDetail", { organizationId, conversationId: id })), _organization_uuid: organizationId };
      await writeJson(filesystem, `${root}/metadata.json`, row);
      await writeJson(filesystem, `${root}/conversation.json`, detail);
      const files = claudeFiles(detail);
      const assetManifest: JsonRecord[] = [];
      for (const [index, file] of files.entries()) {
        try {
          const path = `${root}/assets/${String(index + 1).padStart(4, "0")}-${pathSegment(file.name)}`;
          const response = await storeProviderAsset(filesystem, path, "https://claude.ai/*", "claudeFile", { organizationId, conversationId: id, ...(file.fileUuid ? { fileUuid: file.fileUuid, previewUrl: file.previewUrl } : { sandboxPath: file.sandboxPath }) });
          assetManifest.push({ ...file, path, bytes: response.size, contentType: response.contentType, sourceVariant: response.variant, hash: response.hash });
        } catch (error) {
          assetManifest.push({ ...file, error: messageOf(error) });
        }
      }
      await writeJson(filesystem, `${root}/assets.json`, assetManifest);
      const sourceHash = await sha256Hex(JSON.stringify(detail));
      const assetFailures = assetManifest.filter((item) => item.error).length;
      const marker = assetFailures ? "incomplete" : "complete";
      await writeJson(filesystem, `${root}/${marker}.json`, { schemaVersion: 1, sourceHash, assets: assetManifest.length, failedAssets: assetFailures, completedAt: new Date().toISOString() });
      await removeIfExists(filesystem, `${root}/${assetFailures ? "complete" : "incomplete"}.json`);
      await removeIfExists(filesystem, `${root}/error.json`);
      if (assetFailures) failed += 1;
      fetched += 1;
    } catch (error) {
      failed += 1;
      await writeJson(filesystem, `${root}/error.json`, { error: messageOf(error), failedAt: new Date().toISOString() });
    }
    await delay(150);
  }
  if (await writeValidation(filesystem, "claude", listing.length, /^conversations\/[^/]+\/complete\.json$/)) {
    await removeIfExists(filesystem, "conversations.json");
  }
  return { provider: "claude", discovered: listing.length, fetched, unchanged, retained: 0, failed };
}

async function syncGemini(filesystem: ArchiveFileSystem): Promise<SyncSummary> {
  const liveListing = asRecords(await pageRequest("https://gemini.google.com/*", "geminiList"));
  const priorInventory = asRecordsOrEmpty((await readJson<JsonRecord>(filesystem, "inventory.json", {})).conversations);
  const legacy = await readJson<unknown>(filesystem, "conversations.json", {});
  const legacyListing = asRecordsOrEmpty(asRecordOrEmpty(legacy).conversations);
  const listingById = new Map<string, JsonRecord>();
  for (const row of [...liveListing, ...priorInventory, ...legacyListing]) {
    const id = text(row.id);
    if (id && !listingById.has(id)) listingById.set(id, { id, title: text(row.title) ?? "Untitled", updated_at: row.updated_at ?? null });
  }
  const listing = [...listingById.values()];
  await writeJson(filesystem, "inventory.json", {
    schema: "conversation-exporters/gemini-web/3",
    sourceListingCount: liveListing.length,
    retainedListingCount: listing.length - liveListing.length,
    conversations: listing,
  });
  await writeJson(filesystem, "source/account.json", await pageRequest("https://gemini.google.com/*", "geminiAccount"));
  let fetched = 0, unchanged = 0, failed = 0;
  try {
    const gems = asRecord(await pageRequest("https://gemini.google.com/*", "geminiGems"));
    await writeJson(filesystem, "gems/index.json", gems.provider_raw);
    for (const record of asRecordsOrEmpty(gems.gems)) {
      const id = text(record.id); if (!id) continue;
      const root = `gems/${pathSegment(id)}`;
      await writeJson(filesystem, `${root}/gem.json`, record);
      await writeJson(filesystem, `${root}/complete.json`, { schemaVersion: 1, sourceHash: await sha256Hex(JSON.stringify(record)), completedAt: new Date().toISOString() });
    }
    await removeIfExists(filesystem, "gems/error.json");
  } catch (error) {
    failed += 1;
    await writeJson(filesystem, "gems/error.json", { error: messageOf(error), failedAt: new Date().toISOString() });
  }
  await forEachConcurrent(listing, 2, async (row) => {
    const id = text(row.id); if (!id) return;
    const root = `conversations/${pathSegment(id)}`;
    const prior = await readJson<JsonRecord>(filesystem, `${root}/metadata.json`, {});
    if (prior.updated_at === row.updated_at && await filesystem.exists(`${root}/complete.json`)) { unchanged += 1; return; }
    try {
      const detail = asRecord(await pageRequest("https://gemini.google.com/*", "geminiDetail", { conversationId: id }));
      if (!Array.isArray(detail.messages) || !detail.messages.length) throw new Error("Gemini rendered no messages for a listed conversation");
      const record = { ...row, ...detail };
      await writeJson(filesystem, `${root}/metadata.json`, row);
      await writeJson(filesystem, `${root}/conversation.json`, record);
      const assets = providerAssetUrls(detail);
      const assetManifest = await downloadProviderAssets(filesystem, root, assets, "https://gemini.google.com/*", "geminiAsset");
      await writeJson(filesystem, `${root}/assets.json`, assetManifest);
      const incomplete = detail.possibly_truncated === true || assetManifest.some((asset) => asset.error);
      await writeJson(filesystem, `${root}/${incomplete ? "incomplete" : "complete"}.json`, { schemaVersion: 1, sourceHash: await sha256Hex(JSON.stringify(detail)), assets: assetManifest.length, failedAssets: assetManifest.filter((asset) => asset.error).length, possiblyTruncated: detail.possibly_truncated === true, completedAt: new Date().toISOString() });
      await removeIfExists(filesystem, `${root}/${incomplete ? "complete" : "incomplete"}.json`);
      await removeIfExists(filesystem, `${root}/error.json`);
      if (incomplete) failed += 1;
      fetched += 1;
    } catch (error) {
      failed += 1;
      await writeJson(filesystem, `${root}/error.json`, { error: messageOf(error), failedAt: new Date().toISOString() });
    }
    await delay(250);
  });
  if (await writeValidation(filesystem, "gemini", listing.length, /^conversations\/[^/]+\/complete\.json$/)) {
    await removeIfExists(filesystem, "conversations.json");
  }
  return { provider: "gemini", discovered: listing.length, fetched, unchanged, retained: 0, failed };
}

async function syncAiStudio(filesystem: ArchiveFileSystem): Promise<SyncSummary> {
  const inventoryRows = asArrays(await pageRequest("https://aistudio.google.com/*", "aiStudioInventory"));
  const prompts = inventoryRows.map((inventory) => ({ id: text(inventory[0]), inventory }));
  await writeJson(filesystem, "inventory.json", { schema: "conversation-exporters/ai-studio-web/3", prompts });
  let fetched = 0, unchanged = 0, failed = 0;
  for (const raw of prompts) {
    const id = text(raw.id); if (!id) continue;
    const root = `prompts/${pathSegment(id)}`;
    try {
      const detail = await pageRequest("https://aistudio.google.com/*", "aiStudioDetail", { inventory: raw.inventory });
      const hash = await sha256Hex(JSON.stringify({ inventory: raw.inventory, detail }));
      const complete = await readJson<JsonRecord>(filesystem, `${root}/complete.json`, {});
      if (complete.sourceHash === hash && complete.assetDiscoveryVersion === 2) { unchanged += 1; await removeIfExists(filesystem, `${root}/error.json`); continue; }
      const metadata = Array.isArray(raw.inventory[4]) ? raw.inventory[4] : [];
      const record = { id, title: text(metadata[0]) || text(metadata[1]) || "Untitled", hash, inventory: raw.inventory, detail };
      await writeJson(filesystem, `${root}/prompt.json`, record);
      const assetSource = { ...raw, detail };
      const ownDriveId = id.split("/").at(-1);
      const driveIds = providerDriveIds(assetSource).filter((candidate) => candidate !== ownDriveId);
      const urls = providerAssetUrls(assetSource);
      const assetManifest: JsonRecord[] = [];
      for (const [index, driveId] of driveIds.entries()) {
        try {
          const path = `${root}/assets/drive-${String(index + 1).padStart(4, "0")}-${pathSegment(driveId)}`;
          const response = await storeProviderAsset(filesystem, path, "https://aistudio.google.com/*", "aiStudioAsset", { driveId });
          assetManifest.push({ driveId, path, bytes: response.size, contentType: response.contentType, hash: response.hash });
        } catch (error) { assetManifest.push({ driveId, error: messageOf(error) }); }
      }
      assetManifest.push(...await downloadProviderAssets(filesystem, root, urls, "https://aistudio.google.com/*", "aiStudioAsset", assetManifest.length));
      await writeJson(filesystem, `${root}/assets.json`, assetManifest);
      const assetFailures = assetManifest.filter((asset) => asset.error).length;
      await writeJson(filesystem, `${root}/${assetFailures ? "incomplete" : "complete"}.json`, { schemaVersion: 1, assetDiscoveryVersion: 2, sourceHash: hash, assets: assetManifest.length, failedAssets: assetFailures, completedAt: new Date().toISOString() });
      await removeIfExists(filesystem, `${root}/${assetFailures ? "complete" : "incomplete"}.json`);
      await removeIfExists(filesystem, `${root}/error.json`);
      if (assetFailures) failed += 1;
      fetched += 1;
    } catch (error) {
      failed += 1;
      await writeJson(filesystem, `${root}/error.json`, { error: messageOf(error), failedAt: new Date().toISOString() });
    }
  }
  if (await writeValidation(filesystem, "ai-studio", prompts.length, /^prompts\/[^/]+\/complete\.json$/)) {
    await removeIfExists(filesystem, "prompts.json");
  }
  return { provider: "ai-studio", discovered: prompts.length, fetched, unchanged, retained: 0, failed };
}

async function pageRequest(pattern: string, operation: PageRequest["operation"], parameters?: Record<string, unknown>): Promise<unknown> {
  const tabs = await providerTabs(pattern);
  if (!tabs.length) throw new Error(`Open a signed-in ${new URL(pattern.replace("*", "")).hostname} tab`);
  let lastError = "Provider tab did not answer";
  for (const tab of tabs) {
    try {
      return await pageRequestOnTab(tab.id, operation, parameters);
    } catch (error) { lastError = messageOf(error); }
  }
  throw new Error(lastError);
}

async function providerTabs(pattern: string): Promise<Array<chrome.tabs.Tab & { id: number }>> {
  return (await chrome.tabs.query({ url: pattern }))
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
}

async function pageRequestOnTab(tabId: number, operation: PageRequest["operation"], parameters?: Record<string, unknown>): Promise<unknown> {
  const request: PageRequest = { type: "WEB_SYNC_PAGE_REQUEST_V2", requestId: crypto.randomUUID(), operation, ...(parameters ? { parameters } : {}) };
  let reply: PageReply;
  try { reply = await chrome.tabs.sendMessage<PageRequest, PageReply>(tabId, request); }
  catch {
    await installProviderBridge(tabId);
    reply = await chrome.tabs.sendMessage<PageRequest, PageReply>(tabId, request);
  }
  if (!reply?.ok) throw new Error(reply?.error ?? "Provider tab did not answer");
  return reply.result;
}

async function installProviderBridge(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ["web-content-relay.js"] });
  await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ["web-page-bridge.js"], world: "MAIN" });
}

async function readJson<T>(filesystem: ArchiveFileSystem, path: string, fallback: T): Promise<T> { const value = await filesystem.readText(path); return value ? JSON.parse(value) as T : fallback; }
async function writeJson(filesystem: ArchiveFileSystem, path: string, value: unknown): Promise<void> { await filesystem.writeTextAtomic(path, JSON.stringify(value)); }
async function removeIfExists(filesystem: ArchiveFileSystem, path: string): Promise<void> { if (await filesystem.exists(path)) await filesystem.remove(path); }
function asRecords(value: unknown): JsonRecord[] { if (!Array.isArray(value)) throw new Error("Provider inventory was malformed"); return value.filter((row): row is JsonRecord => Boolean(row) && typeof row === "object"); }
function asRecordsOrEmpty(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter((row): row is JsonRecord => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : []; }
function asArrays(value: unknown): unknown[][] { if (!Array.isArray(value)) throw new Error("Provider inventory was malformed"); return value.filter((row): row is unknown[] => Array.isArray(row)); }
function asRecord(value: unknown): JsonRecord { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider detail was malformed"); return value as JsonRecord; }
function asRecordOrEmpty(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function forEachConcurrent<T>(items: readonly T[], limit: number, operation: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await operation(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}
async function runExclusive<T>(operation: () => Promise<T>): Promise<T> { if (active) throw new Error("A sync is already running"); const promise = operation(); active = promise; try { return await promise; } finally { active = undefined; } }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Operation failed"; }

interface ClaudeFileReference extends JsonRecord { name: string; fileUuid?: string; sandboxPath?: string; previewUrl?: string }

function claudeFiles(value: unknown): ClaudeFileReference[] {
  const output = new Map<string, ClaudeFileReference>();
  walk(value, (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const record = item as JsonRecord;
    const sandboxPath = typeof record.path === "string" && record.path.startsWith("/mnt/") ? record.path : undefined;
    const fileUuid = (record.file_kind === "image" || record.kind === "image") ? text(record.file_uuid) ?? text(record.uuid) : undefined;
    const fileRecord = typeof record.file_name === "string" || typeof record.file_kind === "string" || typeof record.size_bytes === "number" || typeof record.file_uuid === "string";
    if ((sandboxPath && fileRecord) || fileUuid) {
      const name = text(record.file_name) ?? text(record.filename) ?? sandboxPath?.split("/").at(-1) ?? fileUuid ?? "file";
      const key = sandboxPath ? `path:${sandboxPath}` : `uuid:${fileUuid}`;
      output.set(key, { name, ...(sandboxPath ? { sandboxPath } : {}), ...(fileUuid ? { fileUuid } : {}), ...(typeof record.preview_url === "string" ? { previewUrl: record.preview_url } : {}), providerMetadata: record });
    }
    if (record.name === "present_files") {
      walk(record, (candidate) => {
        if (typeof candidate !== "string" || !candidate.startsWith("/mnt/")) return;
        output.set(`path:${candidate}`, { name: candidate.split("/").at(-1) ?? "file", sandboxPath: candidate });
      });
    }
  });
  return [...output.values()];
}

function providerAssetUrls(value: unknown): string[] {
  const urls = new Set<string>();
  walk(value, (candidate) => {
    if (typeof candidate !== "string" || !candidate.startsWith("https://")) return;
    try {
      const url = new URL(candidate);
      const allowed = ["googleusercontent.com", "googleapis.com"].some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
      if (allowed && !/\/a\/(?:ACg|AOh)[A-Za-z0-9_-]+(?:=s\d+)?$/.test(url.pathname)) urls.add(url.href);
    } catch { /* malformed provider value */ }
  });
  return [...urls].sort();
}

function providerDriveIds(value: unknown): string[] {
  const ids = new Set<string>();
  walk(value, (candidate) => {
    if (typeof candidate !== "string") return;
    if (/^[A-Za-z0-9_-]{25,50}$/.test(candidate) && /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /[0-9]/.test(candidate)) ids.add(candidate);
    if (!/^https:\/\/(?:drive|docs)\.google\.com\//.test(candidate)) return;
    for (const match of candidate.matchAll(/(?:\/d\/|[?&]id=)([A-Za-z0-9_-]{20,100})/g)) if (match[1]) ids.add(match[1]);
  });
  return [...ids].sort();
}

async function downloadProviderAssets(filesystem: ArchiveFileSystem, root: string, urls: string[], pattern: string, operation: "geminiAsset" | "aiStudioAsset", start = 0): Promise<JsonRecord[]> {
  const output: JsonRecord[] = [];
  for (const [offset, url] of urls.entries()) {
    try {
      const fallback = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? `asset-${offset + 1}`;
      const path = `${root}/assets/${String(start + offset + 1).padStart(4, "0")}-${pathSegment(fallback)}`;
      const response = await storeProviderAsset(filesystem, path, pattern, operation, { url });
      output.push({ url, path, bytes: response.size, contentType: response.contentType, hash: response.hash });
    } catch (error) { output.push({ url, error: messageOf(error) }); }
  }
  return output;
}

async function writeValidation(filesystem: ArchiveFileSystem, provider: DirectProvider, discovered: number, completePattern: RegExp): Promise<boolean> {
  const paths = await filesystem.listPaths();
  const complete = paths.filter((path) => completePattern.test(path)).length;
  const incomplete = paths.filter((path) => /\/(?:incomplete|error)\.json$/.test(path)).length;
  const valid = complete === discovered && incomplete === 0;
  await writeJson(filesystem, "validation.json", { schemaVersion: 1, provider, discovered, complete, incomplete, valid, checkedAt: new Date().toISOString() });
  return valid;
}

async function storeProviderAsset(filesystem: ArchiveFileSystem, path: string, pattern: string, operation: "claudeFile" | "geminiAsset" | "aiStudioAsset", parameters: JsonRecord): Promise<{ size: number; contentType: unknown; variant: unknown; hash: string }> {
  const directUrl = directProviderAssetUrl(operation, parameters);
  if (directUrl) {
    const origin = `${new URL(directUrl).origin}/*`;
    if (!await chrome.permissions.contains({ origins: [origin] })) {
      throw new Error(`Media download permission is missing for ${new URL(directUrl).hostname}; start the sync from the dashboard and approve it.`);
    }
    const response = await fetchProviderAsset(directUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await filesystem.writeBytesAtomic(path, bytes);
    return { size: bytes.byteLength, contentType: response.headers.get("content-type"), variant: "provider", hash: await sha256Hex(bytes) };
  }
  const [tab] = await providerTabs(pattern);
  if (!tab) throw new Error(`Open a signed-in ${new URL(pattern.replace("*", "")).hostname} tab`);
  const begin = asRecord(await pageRequestOnTab(tab.id, operation, { ...parameters, phase: "begin" }));
  const transferId = text(begin.transferId); const size = typeof begin.size === "number" ? begin.size : NaN;
  if (!transferId || !Number.isSafeInteger(size) || size < 0) throw new Error("Provider asset transfer was malformed");
  try {
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (let offset = 0; offset < size; offset += 262_144) {
        const result = asRecord(await pageRequestOnTab(tab.id, operation, { phase: "chunk", transferId, offset, length: Math.min(262_144, size - offset) }));
        yield decodeBase64(text(result.base64) ?? "");
      }
    }
    await filesystem.writeByteChunksAtomic(path, chunks());
    const bytes = await filesystem.readBytes(path);
    if (!bytes || bytes.byteLength !== size) throw new Error("Provider asset size did not match the transfer manifest");
    return { size, contentType: begin.contentType, variant: begin.variant, hash: await sha256Hex(bytes) };
  } finally {
    await pageRequestOnTab(tab.id, operation, { phase: "end", transferId }).catch(() => undefined);
  }
}

async function fetchProviderAsset(url: string): Promise<Response> {
  let lastError = "Provider asset request failed";
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetch(url, { credentials: "include", headers: { accept: "*/*" }, signal: AbortSignal.timeout(30_000) });
      if (response.ok) return response;
      lastError = `Provider asset request failed (${response.status})`;
      if (response.status !== 429 && response.status < 500) throw new Error(lastError);
      const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      if (attempt < 6) await delay(retryAfter ?? Math.min(1_000 * (2 ** attempt), 15_000));
    } catch (error) {
      lastError = messageOf(error);
      if (attempt === 6) break;
      await delay(Math.min(1_000 * (2 ** attempt), 15_000));
    }
  }
  throw new Error(lastError);
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), 60_000) : undefined;
}

function directProviderAssetUrl(operation: "claudeFile" | "geminiAsset" | "aiStudioAsset", parameters: JsonRecord): string | undefined {
  if (operation === "claudeFile") return undefined;
  if (typeof parameters.url === "string") {
    const url = new URL(parameters.url);
    const allowed = ["googleusercontent.com", "googleapis.com", "usercontent.google.com"].some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
    if (url.protocol !== "https:" || !allowed) throw new Error("Provider asset URL is not allowed");
    return url.href;
  }
  if (operation === "aiStudioAsset" && typeof parameters.driveId === "string") {
    const driveId = parameters.driveId;
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(driveId)) throw new Error("Invalid Drive file ID");
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`;
  }
  return undefined;
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) for (const child of value) walk(child, visit);
  else if (value && typeof value === "object") for (const child of Object.values(value as JsonRecord)) walk(child, visit);
}

function pathSegment(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
  return normalized || "item";
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
