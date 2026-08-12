import { NativeArchiveFileSystem } from "@conversation-exporters/shared/native-filesystem";
import type { PageReply, PageRequest, Provider, SyncSummary } from "./protocol";

type JsonRecord = Record<string, unknown>;
let active: Promise<unknown> | undefined;

chrome.action.onClicked.addListener(() => { void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create("conversation-sync", { periodInMinutes: 60 }); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "conversation-sync") void runExclusive(async () => {
    for (const provider of ["claude", "gemini"] as const) await syncProvider(provider).catch(() => undefined);
  });
});
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const value = message as { type?: string; provider?: Provider };
  if (value.type !== "WEB_SYNC_RUN" || (value.provider !== "claude" && value.provider !== "gemini")) return false;
  void runExclusive(() => syncProvider(value.provider!)).then(
    (result) => sendResponse({ ok: true, result }),
    (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "sync failed" }),
  );
  return true;
});

async function syncProvider(provider: Provider): Promise<SyncSummary> {
  return provider === "claude" ? await syncClaude() : await syncGemini();
}

async function syncClaude(): Promise<SyncSummary> {
  const tab = await providerTab("https://claude.ai/*", "Open a signed-in Claude tab in Zen");
  const listing = asRecords(await pageRequest(tab.id!, "claudeList"));
  const filesystem = new NativeArchiveFileSystem("claude-web");
  const existing = await readJson<JsonRecord[]>(filesystem, "conversations.json", []);
  const previous = new Map(existing.flatMap((row) => typeof row.uuid === "string" ? [[row.uuid, row] as const] : []));
  const output: JsonRecord[] = [];
  let fetched = 0, unchanged = 0;
  for (const row of listing) {
    const id = typeof row.uuid === "string" ? row.uuid : undefined;
    const organizationId = typeof row._organization_uuid === "string" ? row._organization_uuid : undefined;
    if (!id || !organizationId) continue;
    const prior = previous.get(id);
    if (prior && prior.updated_at === row.updated_at) { output.push(prior); previous.delete(id); unchanged += 1; continue; }
    const detail = asRecord(await pageRequest(tab.id!, "claudeDetail", { organizationId, conversationId: id }));
    output.push({ ...detail, _organization_uuid: organizationId });
    previous.delete(id);
    fetched += 1;
    await delay(150);
  }
  output.push(...previous.values());
  output.sort((left, right) => String(left.uuid ?? "").localeCompare(String(right.uuid ?? "")));
  await filesystem.writeTextAtomic("conversations.json", JSON.stringify(output));
  return { provider: "claude", discovered: listing.length, fetched, unchanged, retained: previous.size };
}

async function syncGemini(): Promise<SyncSummary> {
  const inventoryTab = await providerTab("https://gemini.google.com/*", "Open a signed-in Gemini tab in Zen");
  const listing = asGeminiListing(await pageRequest(inventoryTab.id!, "geminiList"));
  const filesystem = new NativeArchiveFileSystem("gemini-web");
  const document = await readJson<{ conversations: JsonRecord[] }>(filesystem, "conversations.json", { conversations: [] });
  const previous = new Map(document.conversations.flatMap((row) => typeof row.id === "string" ? [[row.id, row] as const] : []));
  const output: JsonRecord[] = [];
  let fetched = 0, unchanged = 0;
  const captureTab = await chrome.tabs.create({ active: false, url: "https://gemini.google.com/app" });
  try {
    if (!captureTab.id) throw new Error("Gemini capture tab was unavailable");
    for (const row of listing) {
      const prior = previous.get(row.id);
      if (prior && prior.updated_at === row.updated_at) { output.push(prior); previous.delete(row.id); unchanged += 1; continue; }
      await chrome.tabs.update(captureTab.id, { url: `https://gemini.google.com/app/${encodeURIComponent(row.id)}` });
      await waitForTab(captureTab.id, row.id);
      await delay(1_500);
      const extracted = asRecord(await pageRequest(captureTab.id, "geminiExtract"));
      const messages = Array.isArray(extracted.messages) ? extracted.messages : [];
      if (!messages.length) throw new Error("Gemini rendered no messages for a listed conversation");
      output.push({ ...row, messages });
      previous.delete(row.id);
      fetched += 1;
      await delay(1_000);
    }
  } finally {
    if (captureTab.id) await chrome.tabs.remove(captureTab.id).catch(() => undefined);
  }
  output.push(...previous.values());
  output.sort((left, right) => String(left.id ?? "").localeCompare(String(right.id ?? "")));
  await filesystem.writeTextAtomic("conversations.json", JSON.stringify({ conversations: output }));
  return { provider: "gemini", discovered: listing.length, fetched, unchanged, retained: previous.size };
}

async function providerTab(url: string, missing: string): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url });
  const tab = tabs.find((candidate) => candidate.id !== undefined);
  if (!tab) throw new Error(missing);
  return tab;
}

async function pageRequest(tabId: number, operation: PageRequest["operation"], parameters?: Record<string, unknown>): Promise<unknown> {
  const request: PageRequest = { type: "WEB_SYNC_PAGE_REQUEST", requestId: crypto.randomUUID(), operation, ...(parameters ? { parameters } : {}) };
  const reply = await chrome.tabs.sendMessage<PageRequest, PageReply>(tabId, request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Provider tab did not answer");
  return reply.result;
}

async function waitForTab(tabId: number, expectedId: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.includes("google.com/sorry")) throw new Error("Google CAPTCHA interrupted Gemini sync");
    if (tab.status === "complete" && tab.url?.includes(`/app/${expectedId}`)) return;
    await delay(250);
  }
  throw new Error("Gemini conversation page timed out");
}

async function readJson<T>(filesystem: NativeArchiveFileSystem, path: string, fallback: T): Promise<T> {
  const text = await filesystem.readText(path);
  return text === undefined ? fallback : JSON.parse(text) as T;
}

function asRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error("Provider inventory was malformed");
  return value.filter((row): row is JsonRecord => Boolean(row) && typeof row === "object");
}
function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider detail was malformed");
  return value as JsonRecord;
}
function asGeminiListing(value: unknown): Array<{ id: string; title: string; updated_at: string | null }> {
  return asRecords(value).flatMap((row) => typeof row.id === "string" && typeof row.title === "string"
    ? [{ id: row.id, title: row.title, updated_at: typeof row.updated_at === "string" ? row.updated_at : null }]
    : []);
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (active) throw new Error("A conversation sync is already running");
  const running = operation(); active = running;
  try { return await running; } finally { active = undefined; }
}
