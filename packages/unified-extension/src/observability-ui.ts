import { listBrowserArchiveEntries } from "@conversation-exporters/shared/indexeddb-filesystem";
import { deriveCoverage, type ProviderCoverage } from "./coverage";
import type { RunProgress, ProviderProgress, RunPhase } from "./run-store";
import type { SyncProvider } from "./types";

const providers: SyncProvider[] = ["chatgpt", "grok", "claude", "gemini", "ai-studio"];
const phases: RunPhase[] = ["queued", "discovery", "capture", "assets", "validation", "replication", "complete"];
const phaseNames = ["Queue", "Discover", "Chats", "Assets", "Validate", "Copy", "Finish"];
const statuses = ["captured", "pending", "failed", "retained"] as const;
let coverage: ProviderCoverage[] = [];
let selectedMonth: string | null = null;
let chatPage = 0;
let historyOffset = 0;
let lastRun: RunProgress | undefined;
let refreshPending: Promise<void> | undefined;
let historyRequest = 0;
const pageSize = 50;
const historySize = 10;

export function initializeObservability(onRunning: (running: boolean, message: string, error: boolean) => void): void {
  get("refresh-coverage").addEventListener("click", () => void refreshCoverage());
  for (const id of ["coverage-provider", "coverage-status", "coverage-search"]) get(id).addEventListener(id.endsWith("search") ? "input" : "change", () => { chatPage = 0; renderRecords(); });
  get("coverage-clear").addEventListener("click", () => {
    select("coverage-provider").value = "all"; select("coverage-status").value = "all";
    (get("coverage-search") as HTMLInputElement).value = ""; selectedMonth = null; chatPage = 0; renderCharts(); renderRecords();
  });
  get("coverage-prev").addEventListener("click", () => { chatPage = Math.max(0, chatPage - 1); renderRecords(); });
  get("coverage-next").addEventListener("click", () => { chatPage += 1; renderRecords(); });
  get("refresh-history").addEventListener("click", () => { historyOffset = 0; void refreshHistory(); });
  get("history-prev").addEventListener("click", () => { historyOffset = Math.max(0, historyOffset - historySize); void refreshHistory(); });
  get("history-next").addEventListener("click", () => { historyOffset += historySize; void refreshHistory(); });
  const displayRun = (run: RunProgress | undefined) => {
    lastRun = run; renderRun();
    if (run) onRunning(run.status === "running", `${run.trigger === "scheduled" ? "Automatic" : "Manual"} run · ${run.status}`, !["running", "complete"].includes(run.status));
    if (run && run.status !== "running") { void refreshCoverage(); void refreshHistory(); }
  };
  void chrome.storage.local.get("conversationExporters.runProgress").then((values) => displayRun(values["conversationExporters.runProgress"] as RunProgress | undefined));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["conversationExporters.runProgress"]) displayRun(changes["conversationExporters.runProgress"].newValue as RunProgress);
  });
  // Refresh metadata at a modest cadence, not once per chat event.
  window.setInterval(() => { if (lastRun?.status === "running") { renderRun(); void refreshCoverage(); } }, 10_000);
  const notify = get("notify-runs") as HTMLInputElement;
  void chrome.storage.local.get("conversationExporters.notificationsEnabled").then((values) => { notify.checked = values["conversationExporters.notificationsEnabled"] === true; });
  notify.addEventListener("change", () => void (async () => {
    if (notify.checked && !await chrome.permissions.request({ permissions: ["notifications"] })) notify.checked = false;
    await chrome.storage.local.set({ "conversationExporters.notificationsEnabled": notify.checked });
  })().catch(() => { notify.checked = false; }));
  void refreshCoverage(); void refreshHistory();
}

export function refreshCoverage(): Promise<void> {
  if (refreshPending) return refreshPending;
  refreshPending = (async () => {
    try {
      coverage = await deriveCoverage(await listBrowserArchiveEntries());
      get("coverage-updated").textContent = `Metadata refreshed ${new Date().toLocaleTimeString()} · ${coverage.reduce((sum, item) => sum + item.rows.length, 0)} known records. Dates use UTC months.`;
      renderCharts(); renderRecords();
    } catch (error) { get("coverage-updated").textContent = `Could not read coverage: ${String(error)}`; }
  })().finally(() => { refreshPending = undefined; });
  return refreshPending;
}

function renderCharts(): void {
  const container = get("coverage-charts"); container.replaceChildren();
  for (const provider of providers) {
    const data = coverage.find((item) => item.provider === provider);
    const chart = element("div", "coverage-chart");
    const heading = element("div", "coverage-chart__heading"); heading.append(element("strong", "", label(provider)));
    const rows = data?.rows ?? [];
    heading.append(element("span", "", `${rows.length} found · ${rows.filter((row) => row.status === "captured").length} captured · ${rows.filter((row) => row.status === "failed").length} failed`)); chart.append(heading);
    if (!data || !rows.length) { chart.append(element("p", "small-note", "No conversation inventory yet. Run this provider to discover its history.")); container.append(chart); continue; }
    const bins = [...data.bins];
    // Keep a real calendar axis, including months containing no conversations.
    if (bins.length > 1) {
      const first = bins[0]!.month, last = bins.at(-1)!.month;
      const start = Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7)) - 1;
      const end = Number(last.slice(0, 4)) * 12 + Number(last.slice(5, 7)) - 1;
      if (end - start < 1200) {
        const existing = new Map(bins.map((bin) => [bin.month, bin])); bins.length = 0;
        for (let month = start; month <= end; month++) {
          const key = `${Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, "0")}`;
          bins.push(existing.get(key) ?? { month: key, captured: 0, pending: 0, failed: 0, retained: 0 });
        }
      }
    }
    if (Object.values(data.unknownDate).some((v) => typeof v === "number" && v > 0)) bins.push(data.unknownDate);
    const max = Math.max(1, ...bins.map((bin) => statuses.reduce((sum, status) => sum + bin[status], 0)));
    const bars = element("div", "coverage-bars"); bars.setAttribute("aria-label", `${label(provider)} monthly discovery and capture counts`);
    for (const bin of bins) {
      const button = element("button", "coverage-bar");
      const caption = `${bin.month}: ${statuses.map((status) => `${bin[status]} ${status}`).join(", ")}`;
      button.title = caption; button.setAttribute("aria-label", caption);
      button.setAttribute("aria-pressed", String(selectedMonth === bin.month && select("coverage-provider").value === provider));
      for (const status of statuses) if (bin[status]) { const segment = element("span"); segment.dataset.capture = status; segment.style.height = `${bin[status] / max * 100}%`; button.append(segment); }
      button.addEventListener("click", () => { selectedMonth = bin.month; select("coverage-provider").value = provider; chatPage = 0; renderCharts(); renderRecords(); });
      bars.append(button);
    }
    chart.append(bars);
    const axis = element("div", "coverage-axis"); axis.append(element("span", "", bins[0]?.month ?? "Unknown date"), element("span", "", `Peak ${max} chats / bucket · hover for counts`), element("span", "", bins.at(-1)?.month ?? "")); chart.append(axis);
    container.append(chart);
  }
}

function renderRecords(): void {
  const provider = select("coverage-provider").value;
  const status = select("coverage-status").value;
  const query = (get("coverage-search") as HTMLInputElement).value.trim().toLowerCase();
  const rows = coverage.flatMap((item) => item.rows).filter((row) => (provider === "all" || row.provider === provider) && (status === "all" || row.status === status) && (!selectedMonth || (row.date?.slice(0, 7) ?? "unknown") === selectedMonth) && (!query || `${row.title} ${row.id}`.toLowerCase().includes(query))).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)); chatPage = Math.min(chatPage, pages - 1);
  get("coverage-selection").textContent = `${rows.length} matching conversations${selectedMonth ? ` · ${selectedMonth}` : ""}`;
  const body = get("coverage-records"); body.replaceChildren();
  for (const row of rows.slice(chatPage * pageSize, (chatPage + 1) * pageSize)) {
    const tr = element("tr"); const name = element("td", "", row.title || "Untitled"); name.append(element("small", "", `${label(row.provider)} · ${row.id}`));
    const date = element("td", "", row.date?.slice(0, 10) ?? "Unknown"); date.append(element("small", "", row.dateKind));
    const state = element("td", "capture-label", row.status); state.dataset.capture = row.status; tr.append(name, date, state); body.append(tr);
  }
  if (!rows.length) { const tr = element("tr"); const td = element("td", "", "No conversations match these filters."); td.colSpan = 3; tr.append(td); body.append(tr); }
  get("coverage-page").textContent = `Page ${chatPage + 1} of ${pages}`;
  (get("coverage-prev") as HTMLButtonElement).disabled = chatPage === 0; (get("coverage-next") as HTMLButtonElement).disabled = chatPage + 1 >= pages;
}

function renderRun(): void {
  const run = lastRun;
  get("run-overview").textContent = run ? `${run.trigger} · ${duration(run.startedAt, run.completedAt)} · ${Object.values(run.providers).filter((item) => item.status === "running").length} providers active` : "No run recorded yet.";
  const container = get("provider-progress"); container.replaceChildren();
  for (const provider of providers) {
    const state = run?.providers[provider];
    const row = element("div", "provider-progress"); row.dataset.state = state?.status ?? "idle";
    const title = element("div", "provider-progress__title"); title.append(element("strong", "", label(provider)), element("small", "", state?.status ?? "not in run")); row.append(title);
    const strip = element("div", "phase-strip");
    phases.forEach((phase, index) => { const chip = element("span", "", phaseNames[index]); chip.title = `${phase}${state?.phases?.[phase] ? ` · observed ${state.phases[phase]!.startedAt}` : " · not yet observed"}`; chip.dataset.phaseState = state?.phase === phase && state.status === "running" ? "current" : state?.phases?.[phase] ? "seen" : "waiting"; strip.append(chip); });
    row.append(strip);
    if (state) {
      row.append(element("p", "", state.message)); row.append(element("p", "small-note", counters(state)));
      if (state.discovered !== undefined && state.discovered > 0 && state.processed !== undefined) { const progress = element("progress"); progress.max = state.discovered; progress.value = Math.min(state.processed, state.discovered); progress.setAttribute("aria-label", `${label(provider)} conversations processed`); row.append(progress); }
    }
    container.append(row);
  }
}

async function refreshHistory(): Promise<void> {
  const request = ++historyRequest;
  try {
    const response = await chrome.runtime.sendMessage({ type: "UNIFIED_RUN_HISTORY", limit: historySize, offset: historyOffset }) as { ok: boolean; result?: { runs: RunProgress[]; total: number }; error?: string };
    if (request !== historyRequest) return;
    if (!response.ok || !response.result) throw new Error(response.error ?? "Run history unavailable");
    const container = get("run-history"); container.replaceChildren();
    for (const run of response.result.runs) {
      const record = element("details", "run-record"); const summary = element("summary"); summary.append(element("strong", "", `${run.trigger} · ${run.status}`), element("small", "", `${new Date(run.startedAt).toLocaleString()} · ${duration(run.startedAt, run.completedAt)}`)); record.append(summary);
      for (const [provider, state] of Object.entries(run.providers)) {
        record.append(element("h3", "", `${label(provider as SyncProvider)} · ${state.status}`));
        record.append(element("pre", "", `${state.message}\n${counters(state)}\n${Object.entries(state.phases ?? {}).map(([phase, stamp]) => `${phase}: ${stamp.startedAt} → ${stamp.updatedAt}`).join("\n")}`));
      }
      record.append(element("p", "small-note", `Run ID: ${run.runId}`)); container.append(record);
    }
    if (!response.result.runs.length) container.append(element("p", "small-note", "No runs recorded yet. Start a sync to record its phases and results."));
    get("history-page").textContent = `${response.result.total} recorded runs · ${Math.floor(historyOffset / historySize) + 1}/${Math.max(1, Math.ceil(response.result.total / historySize))}`;
    (get("history-prev") as HTMLButtonElement).disabled = historyOffset === 0;
    (get("history-next") as HTMLButtonElement).disabled = historyOffset + historySize >= response.result.total;
  } catch (error) { if (request === historyRequest) get("run-history").textContent = String(error); }
}

function counters(state: ProviderProgress): string {
  return [["found", state.discovered], ["processed", state.processed], ["fetched", state.fetched], ["unchanged", state.unchanged], ["failed", state.failed]].filter(([, value]) => value !== undefined).map(([name, value]) => `${value} ${name}`).join(" · ");
}
function duration(start: string, end?: string): string { const seconds = Math.max(0, Math.round((Date.parse(end ?? new Date().toISOString()) - Date.parse(start)) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function label(provider: SyncProvider): string { return provider === "chatgpt" ? "ChatGPT" : provider === "ai-studio" ? "AI Studio" : provider[0]!.toUpperCase() + provider.slice(1); }
function get(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error(`Missing ${id}`); return value; }
function select(id: string): HTMLSelectElement { return get(id) as HTMLSelectElement; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
