import { IndexedDbArchiveFileSystem } from "@conversation-exporters/shared/indexeddb-filesystem";
import type { SyncProvider } from "./types";

export const RUN_PROGRESS_KEY = "conversationExporters.runProgress";
export type RunPhase = "queued" | "discovery" | "capture" | "assets" | "validation" | "replication" | "complete";
export type RunStatus = "queued" | "running" | "complete" | "partial" | "failed" | "cancelled" | "interrupted";
export interface ProviderProgress {
  phase: RunPhase;
  status: RunStatus;
  message: string;
  discovered?: number;
  processed?: number;
  fetched?: number;
  unchanged?: number;
  failed?: number;
  startedAt?: string;
  completedAt?: string;
  phases?: Partial<Record<RunPhase, { startedAt: string; updatedAt: string }>>;
}
export interface RunProgress {
  runId: string;
  trigger: "manual" | "scheduled";
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  providers: Partial<Record<SyncProvider, ProviderProgress>>;
}
const archive = new IndexedDbArchiveFileSystem("run-history");
let current: RunProgress | undefined;
let pending = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;

function persist(): Promise<void> {
  if (!current) return pending;
  const snapshot = structuredClone(current);
  pending = pending.catch(() => undefined).then(async () => {
    await archive.writeTextAtomic(`${snapshot.startedAt.replace(/:/g, "-")}-${snapshot.runId}.json`, JSON.stringify(snapshot));
    await chrome.storage.local.set({ [RUN_PROGRESS_KEY]: snapshot });
    const running = Object.values(snapshot.providers).filter((state) => state.status === "running").length;
    const attention = snapshot.status !== "running" && snapshot.status !== "complete";
    await chrome.action.setBadgeText?.({ text: snapshot.status === "running" ? String(running) : attention ? "!" : "" });
    await chrome.action.setTitle?.({ title: snapshot.status === "running" ? `Conversation Archive: ${running} providers running` : `Conversation Archive: ${snapshot.status}` });
  });
  return pending;
}
export async function beginRun(providers: SyncProvider[], trigger: RunProgress["trigger"]): Promise<void> {
  current = { runId: crypto.randomUUID(), trigger, status: "running", startedAt: new Date().toISOString(), providers: Object.fromEntries(providers.map((provider) => [provider, { phase: "queued", status: "queued", message: "Waiting for a provider slot" }])) };
  await persist();
}
export function updateProvider(provider: SyncProvider, patch: Partial<ProviderProgress>): void {
  const previous = current?.providers[provider];
  if (!current || !previous) return;
  const now = new Date().toISOString();
  const phase = patch.phase ?? previous.phase;
  current.providers[provider] = { ...previous, ...patch, phases: { ...previous.phases, [phase]: { startedAt: previous.phases?.[phase]?.startedAt ?? now, updatedAt: now } } };
  if (!timer) timer = setTimeout(() => { timer = undefined; void persist().catch(console.error); }, 500);
}
export async function finishRun(cancelled = false): Promise<void> {
  if (!current) return;
  if (timer) clearTimeout(timer); timer = undefined;
  const now = new Date().toISOString();
  for (const provider of Object.keys(current.providers) as SyncProvider[]) {
    const state = current.providers[provider]!;
    if (state.status === "queued" || state.status === "running") updateProvider(provider, { status: cancelled ? "cancelled" : "failed", completedAt: now, message: cancelled ? "Cancelled; saved records retained" : "Run ended before provider completed" });
  }
  current.status = cancelled ? "cancelled" : Object.values(current.providers).some((state) => state.status !== "complete") ? "partial" : "complete";
  current.completedAt = now;
  if (timer) clearTimeout(timer); timer = undefined;
  await persist();
  const settings = await chrome.storage.local.get("conversationExporters.notificationsEnabled");
  if (settings["conversationExporters.notificationsEnabled"] === true && await chrome.permissions.contains({ permissions: ["notifications"] })) {
    await chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("provider-icons/chatgpt.svg"), title: "Conversation Archive", message: `Sync ${current.status}. ${Object.values(current.providers).filter((state) => state.status === "complete").length} of ${Object.keys(current.providers).length} providers completed. Open the dashboard for details.` }).catch(() => undefined);
  }
}
export async function recoverRun(): Promise<void> {
  const prior = (await chrome.storage.local.get(RUN_PROGRESS_KEY))[RUN_PROGRESS_KEY] as RunProgress | undefined;
  if (prior?.status !== "running") return;
  current = prior;
  const now = new Date().toISOString();
  for (const state of Object.values(current.providers)) if (state.status === "running" || state.status === "queued") Object.assign(state, { status: "interrupted", completedAt: now, message: "Background stopped; sync again to resume saved records" });
  current.status = "interrupted"; current.completedAt = now;
  await persist();
}
export async function runHistory(limit = 20, offset = 0): Promise<{ runs: RunProgress[]; total: number; offset: number; limit: number }> {
  limit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
  offset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const paths = (await archive.listPaths()).filter((path) => path.endsWith(".json")).sort().reverse();
  const runs = await Promise.all(paths.slice(offset, offset + limit).map(async (path) => JSON.parse((await archive.readText(path))!) as RunProgress));
  return { runs, total: paths.length, offset, limit };
}
