import type { BrowserArchiveEntry } from "@conversation-exporters/shared/indexeddb-filesystem";
import type { ArchiveNamespace } from "./types";

export interface ArchiveSummary {
  namespace: ArchiveNamespace;
  files: number;
  bytes: number;
  recordKind: "chat" | "prompt";
  captured: number;
  discovered?: number;
  workspaces?: number;
  projects?: number;
  assets?: number;
}

export async function summarizeBrowserArchives(entries: BrowserArchiveEntry[]): Promise<ArchiveSummary[]> {
  const grouped = new Map<ArchiveNamespace, BrowserArchiveEntry[]>();
  for (const entry of entries) {
    if (!isArchiveNamespace(entry.namespace)) continue;
    const group = grouped.get(entry.namespace) ?? [];
    group.push(entry);
    grouped.set(entry.namespace, group);
  }
  return await Promise.all([...grouped].map(([namespace, group]) => summarizeArchive(namespace, group)));
}

async function summarizeArchive(namespace: ArchiveNamespace, entries: BrowserArchiveEntry[]): Promise<ArchiveSummary> {
  const base = { namespace, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.blob.size, 0) };
  if (namespace === "chatgpt-web") {
    const captured = matchingPaths(entries, /^ChatGPTExport-[^/]+\/conversations\/[^/]+\/complete\.json$/);
    const workspaces = new Set(entries.flatMap((entry) => entry.path.match(/^(ChatGPTExport-[^/]+)\//)?.[1] ?? [])).size;
    const assets = matchingPaths(entries, /^ChatGPTExport-[^/]+\/assets\/[^/]+$/);
    let discovered = 0, projects = 0;
    for (const entry of entries.filter((candidate) => /^ChatGPTExport-[^/]+\/inventory\.json$/.test(candidate.path))) {
      const inventory = objectValue(await readObject(entry));
      discovered += arrayLength(inventory?.conversations);
      projects += arrayLength(inventory?.projects);
    }
    return { ...base, recordKind: "chat", captured, ...(discovered ? { discovered } : {}), workspaces, projects, assets };
  }
  if (namespace === "grok-web") {
    const inventory = objectValue(await readObject(entries.find((entry) => entry.path === "inventory.json")));
    return {
      ...base,
      recordKind: "chat",
      captured: matchingPaths(entries, /^conversations\/[^/]+\/complete\.json$/),
      ...(arrayLength(inventory?.conversations) ? { discovered: arrayLength(inventory?.conversations) } : {}),
      projects: matchingPaths(entries, /^source\/workspaces\/[^/]+\/workspace\.json$/),
      assets: matchingPaths(entries, /^conversations\/[^/]+\/assets\/[^/]+$/),
    };
  }
  const report = objectValue(await readObject(entries.find((entry) => entry.path === "sync-report.json")));
  const result = objectValue(report?.summary);
  const capturedFromReport = numeric(result?.fetched) + numeric(result?.unchanged) + numeric(result?.retained);
  if (namespace === "google-ai-studio") {
    const fallback = objectValue(await readObject(entries.find((entry) => entry.path === "prompts.json")));
    return { ...base, recordKind: "prompt", captured: capturedFromReport || arrayLength(fallback?.prompts) };
  }
  const fallback = await readObject(entries.find((entry) => entry.path === "conversations.json"));
  const conversations = Array.isArray(fallback) ? fallback.length : arrayLength(objectValue(fallback)?.conversations);
  return { ...base, recordKind: "chat", captured: capturedFromReport || conversations };
}

function matchingPaths(entries: BrowserArchiveEntry[], pattern: RegExp): number {
  return entries.reduce((count, entry) => count + Number(pattern.test(entry.path)), 0);
}

async function readObject(entry: BrowserArchiveEntry | undefined): Promise<Record<string, unknown> | unknown[] | undefined> {
  if (!entry) return undefined;
  try {
    const value: unknown = JSON.parse(await entry.blob.text());
    return value && typeof value === "object" ? value as Record<string, unknown> | unknown[] : undefined;
  } catch { return undefined; }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function arrayLength(value: unknown): number { return Array.isArray(value) ? value.length : 0; }
function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function isArchiveNamespace(value: string): value is ArchiveNamespace {
  return ["chatgpt-web", "claude-web", "gemini-web", "google-ai-studio", "grok-web"].includes(value);
}
