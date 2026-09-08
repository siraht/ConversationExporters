import type { ArchiveFileSystem } from "@conversation-exporters/shared/filesystem";
import { sha256Hex } from "@conversation-exporters/shared/hash";

export interface VpsSettings { enabled: boolean; baseUrl: string; token: string }
export interface VpsSummary { uploaded: number; unchanged: number; failed: number }
export async function syncFilesystem(namespace: string, filesystem: ArchiveFileSystem, settings: VpsSettings): Promise<VpsSummary> {
  if (!settings.enabled) return { uploaded: 0, unchanged: 0, failed: 0 };
  validateSettings(settings);
  const destination = new URL(settings.baseUrl).href.replace(/\/+$/, "");
  const stateKey = `conversationExporters.vpsState.${await sha256Hex(destination)}.${namespace}`;
  const state = ((await chrome.storage.local.get(stateKey))[stateKey] ?? {}) as Record<string, string>;
  let uploaded = 0, unchanged = 0, failed = 0;
  for (const path of await filesystem.listPaths()) {
    const bytes = await filesystem.readBytes(path); if (!bytes) continue;
    const hash = await sha256Hex(bytes);
    try {
      const url = `${settings.baseUrl}/v1/archives/${encodeURIComponent(namespace)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
      if (state[path] === hash) {
        const remote = await fetch(url, { method: "HEAD", headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(30_000) });
        if (remote.ok && remote.headers.get("x-content-sha256") === hash) { unchanged += 1; continue; }
        if (remote.status === 401 || remote.status === 403) throw new Error("Receiver access denied");
      }
      const response = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/octet-stream", "X-Content-SHA256": hash }, body: ownedBuffer(bytes), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`VPS upload failed (${response.status})`);
      state[path] = hash; uploaded += 1; await chrome.storage.local.set({ [stateKey]: state });
    } catch { failed += 1; }
  }
  return { uploaded, unchanged, failed };
}

export async function testVps(settings: VpsSettings): Promise<void> {
  validateSettings(settings);
  const response = await fetch(`${settings.baseUrl}/v1/status`, { headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`VPS connection failed (${response.status})`);
}
function validateSettings(value: VpsSettings): void {
  const url = new URL(value.baseUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("VPS URL must use HTTPS (plain HTTP is allowed only for localhost)");
  if (value.token.length < 16) throw new Error("VPS token must be at least 16 characters");
}
function ownedBuffer(value: Uint8Array): ArrayBuffer { const copy = new Uint8Array(value.byteLength); copy.set(value); return copy.buffer; }
