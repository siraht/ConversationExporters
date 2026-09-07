import type { BrowserArchiveEntry } from "@conversation-exporters/shared/indexeddb-filesystem";

export type CoverageProvider = "chatgpt" | "claude" | "gemini" | "ai-studio" | "grok";
export type CoverageStatus = "captured" | "pending" | "failed" | "retained";
export interface CoverageRow {
  id: string; title: string; provider: CoverageProvider; date: string | null;
  dateKind: "created" | "updated" | "unknown"; status: CoverageStatus;
}
export interface CoverageBin { month: string; captured: number; pending: number; failed: number; retained: number }
export interface ProviderCoverage {
  provider: CoverageProvider; rows: CoverageRow[]; bins: CoverageBin[]; unknownDate: CoverageBin;
}
type RecordValue = Record<string, unknown>;
const providers: Record<string, CoverageProvider> = {
  "chatgpt-web": "chatgpt", "claude-web": "claude", "gemini-web": "gemini", "google-ai-studio": "ai-studio", "grok-web": "grok",
};
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const segment = (id: string): string => id.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || "item";
const emptyBin = (month: string): CoverageBin => ({ month, captured: 0, pending: 0, failed: 0, retained: 0 });

function dateValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const date = new Date(typeof value === "number" ? (Math.abs(value) < 1e11 ? value * 1000 : value) : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function dated(row: RecordValue): Pick<CoverageRow, "date" | "dateKind"> {
  for (const field of ["createTime", "createdAt", "created_at", "create_time"]) {
    const date = dateValue(row[field]); if (date) return { date, dateKind: "created" };
  }
  for (const field of ["updateTime", "updatedAt", "updated_at", "update_time"]) {
    const date = dateValue(row[field]); if (date) return { date, dateKind: "updated" };
  }
  return { date: null, dateKind: "unknown" };
}
async function json(entry: BrowserArchiveEntry): Promise<RecordValue> {
  try { return record(JSON.parse(await entry.blob.text())); } catch { return {}; }
}

/** Inventory coverage is not proof of exhaustive provider discovery or asset integrity. */
export async function deriveCoverage(entries: BrowserArchiveEntry[]): Promise<ProviderCoverage[]> {
  const output: ProviderCoverage[] = [];
  for (const [namespace, provider] of Object.entries(providers)) {
    const group = entries.filter((entry) => entry.namespace === namespace);
    const paths = new Set(group.map((entry) => entry.path));
    const rows = new Map<string, CoverageRow>();
    const latestStates = new Map<string, { at: string; failed: boolean }>();
    // Journals are metadata only. A newer failed retry must override an old completion marker.
    for (const entry of group.filter((entry) => /^(ChatGPTExport-[^/]+\/)?runs\/[^/]+\.json$/.test(entry.path))) {
      const journal = await json(entry);
      const prefix = entry.path.includes("/runs/") ? entry.path.split("/runs/")[0] + "/" : "";
      const states = Array.isArray(journal.entries) ? journal.entries : Object.values(record(journal.conversations));
      for (const value of states) {
        const state = record(value), id = string(state.conversationId); if (!id) continue;
        const key = `${prefix}conversations/${segment(id)}`;
        const at = string(state.occurredAt) ?? string(state.updatedAt) ?? "";
        if (!latestStates.has(key) || at >= latestStates.get(key)!.at) latestStates.set(key, { at, failed: ["failed", "terminal_failure"].includes(String(state.to ?? state.state)) });
      }
    }
    const status = (root: string, retained = false): CoverageStatus => {
      if (paths.has(`${root}/error.json`) || paths.has(`${root}/incomplete.json`) || latestStates.get(root)?.failed) return "failed";
      return paths.has(`${root}/complete.json`) ? retained ? "retained" : "captured" : "pending";
    };
    for (const entry of group.filter((entry) => /^(ChatGPTExport-[^/]+\/)?inventory\.json$/.test(entry.path))) {
      const inventory = await json(entry), prefix = entry.path.slice(0, -"inventory.json".length);
      const values = provider === "ai-studio" ? inventory.prompts : inventory.conversations;
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const outer = record(value), row = { ...record(outer.conversation), ...outer };
        const id = string(row.conversationId) ?? string(row.id) ?? string(row.uuid); if (!id) continue;
        const root = `${prefix}${provider === "ai-studio" ? "prompts" : "conversations"}/${segment(id)}`;
        const raw = Array.isArray(row.inventory) ? row.inventory : [];
        const metadata = Array.isArray(raw[4]) ? raw[4] : [];
        rows.set(root, { id: prefix + id, title: string(row.title) ?? string(row.name) ?? string(metadata[0]) ?? string(metadata[1]) ?? "Untitled", provider, ...dated(row), status: status(root) });
      }
    }
    for (const entry of group) {
      const match = entry.path.match(/^((?:ChatGPTExport-[^/]+\/)?(?:conversations|prompts)\/([^/]+))\/(?:complete|error|incomplete)\.json$/);
      if (!match || rows.has(match[1])) continue;
      const prefix = match[1].match(/^(ChatGPTExport-[^/]+\/)/)?.[1] ?? "";
      rows.set(match[1], { id: prefix + match[2], title: match[2], provider, date: null, dateKind: "unknown", status: status(match[1], true) });
    }
    // Retained records can have small metadata files; never parse conversation.json or prompt.json here.
    for (const entry of group.filter((entry) => /\/(?:conversations|prompts)\/[^/]+\/metadata\.json$/.test("/" + entry.path))) {
      const row = rows.get(entry.path.slice(0, -"/metadata.json".length));
      if (!row || row.date !== null) continue;
      const metadata = await json(entry);
      Object.assign(row, dated(metadata));
      row.title = string(metadata.title) ?? string(metadata.name) ?? row.title;
    }
    const bins = new Map<string, CoverageBin>(), unknownDate = emptyBin("unknown");
    for (const row of rows.values()) {
      if (!row.date) { unknownDate[row.status] += 1; continue; }
      const month = row.date.slice(0, 7), bin = bins.get(month) ?? emptyBin(month);
      bin[row.status] += 1; bins.set(month, bin);
    }
    output.push({ provider, rows: [...rows.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id)), bins: [...bins.values()].sort((a, b) => a.month.localeCompare(b.month)), unknownDate });
  }
  return output;
}
