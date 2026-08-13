import { listBrowserArchiveEntries } from "@conversation-exporters/shared/indexeddb-filesystem";
import { zipSync } from "fflate";
import type { ArchiveNamespace, DirectProvider } from "./types";

const status = required<HTMLElement>("status");
const archive = required<HTMLElement>("archive-status");
const vpsEnabled = required<HTMLInputElement>("vps-enabled");
const vpsUrl = required<HTMLInputElement>("vps-url");
const vpsToken = required<HTMLInputElement>("vps-token");
const nativeEnabled = required<HTMLInputElement>("native-enabled");

document.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((button) => button.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(button.dataset.open!) });
}));
document.querySelectorAll<HTMLButtonElement>("[data-provider]").forEach((button) => button.addEventListener("click", () => void syncProvider(button.dataset.provider as DirectProvider, button)));
required<HTMLButtonElement>("sync-direct-all").addEventListener("click", () => void syncDirectAll());
required<HTMLButtonElement>("save-storage").addEventListener("click", () => void saveStorage());
required<HTMLButtonElement>("sync-storage").addEventListener("click", () => void syncStorage());
required<HTMLButtonElement>("refresh-status").addEventListener("click", () => void refresh());
required<HTMLButtonElement>("export-archive").addEventListener("click", () => void exportArchive());
void initialize();

async function initialize(): Promise<void> {
  if (!("showDirectoryPicker" in window)) document.querySelectorAll<HTMLElement>('[data-open$="folder.html"]').forEach((element) => { element.hidden = true; });
  const response = await chrome.runtime.sendMessage({ type: "UNIFIED_GET_SETTINGS" }) as { ok: boolean; settings?: { vpsEnabled: boolean; vpsBaseUrl: string; nativeEnabled: boolean; tokenConfigured: boolean } };
  if (response.ok && response.settings) {
    vpsEnabled.checked = response.settings.vpsEnabled;
    vpsUrl.value = response.settings.vpsBaseUrl;
    nativeEnabled.checked = response.settings.nativeEnabled;
    vpsToken.placeholder = response.settings.tokenConfigured ? "Token retained; enter a value only to replace it" : "Bearer token (20+ characters)";
  }
  await refresh();
}

async function syncProvider(provider: DirectProvider, button?: HTMLButtonElement): Promise<void> {
  setBusy(button, true); setStatus(`Syncing ${label(provider)}…`, "busy");
  try {
    const response = await chrome.runtime.sendMessage({ type: "UNIFIED_SYNC_PROVIDER", provider }) as { ok: boolean; result?: { discovered: number; fetched: number; unchanged: number; failed: number }; error?: string };
    if (!response.ok || !response.result) throw new Error(response.error ?? "Sync failed");
    const result = response.result;
    setStatus(`${label(provider)}: ${result.discovered} discovered, ${result.fetched} fetched, ${result.unchanged} unchanged, ${result.failed} failed.`, result.failed ? "error" : "complete");
    await refreshArchive();
  } catch (error) { setStatus(messageOf(error), "error"); }
  finally { setBusy(button, false); }
}

async function syncDirectAll(): Promise<void> {
  const button = required<HTMLButtonElement>("sync-direct-all"); setBusy(button, true);
  try {
    for (const provider of ["claude", "gemini", "ai-studio"] as const) await syncProvider(provider);
  } finally { setBusy(button, false); }
}

async function saveStorage(): Promise<void> {
  const button = required<HTMLButtonElement>("save-storage"); setBusy(button, true);
  try {
    const requested = {} as chrome.permissions.Permissions & { data_collection?: string[] };
    if (vpsEnabled.checked) {
      requested.origins = [`${new URL(vpsUrl.value).origin}/*`];
      const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & { browser_specific_settings?: { gecko?: unknown } };
      if (manifest.browser_specific_settings?.gecko) requested.data_collection = ["personalCommunications", "websiteContent"];
    }
    if (nativeEnabled.checked) requested.permissions = ["nativeMessaging"];
    if ((requested.origins?.length || requested.permissions?.length || requested.data_collection?.length)
      && !await chrome.permissions.request(requested)) throw new Error("The requested replication permission was not granted");
    const response = await chrome.runtime.sendMessage({ type: "UNIFIED_SAVE_SETTINGS", settings: { vpsEnabled: vpsEnabled.checked, vpsBaseUrl: vpsUrl.value, vpsToken: vpsToken.value, nativeEnabled: nativeEnabled.checked } }) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error ?? "Could not save storage settings");
    vpsToken.value = ""; setStatus("Storage settings saved. Secrets remain in extension-local storage.", "complete");
  } catch (error) { setStatus(messageOf(error), "error"); }
  finally { setBusy(button, false); }
}

async function syncStorage(): Promise<void> {
  const button = required<HTMLButtonElement>("sync-storage"); setBusy(button, true); setStatus("Replicating changed archive files…", "busy");
  try {
    const response = await chrome.runtime.sendMessage({ type: "UNIFIED_SYNC_STORAGE" }) as { ok: boolean; result?: { vpsFiles: number; nativeFiles: number }; error?: string };
    if (!response.ok || !response.result) throw new Error(response.error ?? "Storage sync failed");
    setStatus(`Storage sync complete: ${response.result.vpsFiles} VPS files and ${response.result.nativeFiles} native files changed.`, "complete");
  } catch (error) { setStatus(messageOf(error), "error"); }
  finally { setBusy(button, false); }
}

async function exportArchive(): Promise<void> {
  const button = required<HTMLButtonElement>("export-archive"); setBusy(button, true); setStatus("Building ZIP from the browser archive…", "busy");
  try {
    const selected = required<HTMLSelectElement>("export-provider").value as ArchiveNamespace | "all";
    const entries = (await listBrowserArchiveEntries()).filter((entry) => selected === "all" || entry.namespace === selected);
    const total = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
    if (!entries.length) throw new Error("The selected browser archive is empty");
    if (total > 1_073_741_824) throw new Error("This archive exceeds the 1 GiB in-browser ZIP safety limit. Use VPS or optional native replication for the complete archive.");
    const files: Record<string, Uint8Array> = {};
    for (const entry of entries) files[`${entry.namespace}/${entry.path}`] = new Uint8Array(await entry.blob.arrayBuffer());
    const zip = zipSync(files, { level: 6 });
    const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    try { await chrome.downloads.download({ url, filename: `ConversationArchive-${selected}-${new Date().toISOString().slice(0, 10)}.zip`, saveAs: true }); }
    finally { window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    setStatus(`ZIP ready: ${entries.length} files.`, "complete");
  } catch (error) { setStatus(messageOf(error), "error"); }
  finally { setBusy(button, false); }
}

async function refresh(): Promise<void> { await refreshArchive(); }
async function refreshArchive(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: "UNIFIED_ARCHIVE_STATUS" }) as { ok: boolean; result?: Array<{ namespace: string; files: number; bytes: number }> };
  const results = response.ok ? response.result ?? [] : [];
  const byNamespace = new Map(results.map((item) => [item.namespace, item]));
  document.querySelectorAll<HTMLElement>("[data-archive]").forEach((cell) => {
    const item = byNamespace.get(cell.dataset.archive ?? "");
    const amount = cell.querySelector<HTMLElement>("strong");
    const detail = cell.querySelector<HTMLElement>("span");
    if (!amount || !detail) return;
    amount.textContent = item ? formatBytes(item.bytes) : "—";
    detail.textContent = item ? `${item.files} file${item.files === 1 ? "" : "s"}` : "No browser archive yet";
    cell.dataset.populated = String(Boolean(item));
  });
  const totalFiles = results.reduce((sum, item) => sum + item.files, 0);
  const totalBytes = results.reduce((sum, item) => sum + item.bytes, 0);
  archive.textContent = totalFiles ? `${totalFiles} files · ${formatBytes(totalBytes)} total` : "Browser archive is empty";
}

function required<T extends HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element as T; }
function setBusy(button: HTMLButtonElement | undefined, value: boolean): void { if (button) { button.disabled = value; button.setAttribute("aria-busy", String(value)); } }
function setStatus(message: string, state: string): void {
  status.textContent = message;
  status.dataset.state = state;
  status.closest<HTMLElement>(".activity-rail")?.setAttribute("data-state", state);
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Operation failed"; }
function label(provider: DirectProvider): string { return provider === "ai-studio" ? "AI Studio" : provider[0]!.toUpperCase() + provider.slice(1); }
function formatBytes(bytes: number): string { return bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1_073_741_824 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${(bytes / 1_073_741_824).toFixed(2)} GiB`; }
