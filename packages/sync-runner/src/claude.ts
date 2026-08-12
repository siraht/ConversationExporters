import { join } from "node:path";
import type { Page } from "playwright";
import { launchProviderBrowser } from "./browser.js";
import { readJson, writePrivateJson } from "./files.js";
import type { SyncConfig } from "./types.js";

type ClaudeRecord = Record<string, unknown> & { uuid?: string; updated_at?: string };

export interface CaptureSummary {
  provider: "claude-web" | "gemini-web";
  discovered: number;
  fetched: number;
  unchanged: number;
  retained: number;
}

export async function captureClaude(config: SyncConfig, headed = false): Promise<CaptureSummary> {
  const context = await launchProviderBrowser(config, "claude", headed);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (/login|auth/.test(page.url())) throw new Error("Claude sign-in is required; run conversation-sync login claude");

    const organizations = await page.evaluate(async () => {
      const response = await fetch("/api/organizations", { credentials: "include" });
      if (!response.ok) throw new Error(`Claude organizations request failed (${response.status})`);
      return await response.json() as Array<{ uuid?: string }>;
    });
    const organizationIds = organizations.flatMap((organization) => organization.uuid ? [organization.uuid] : []);
    if (organizationIds.length === 0) throw new Error("Claude returned no accessible organizations");

    const listings: Array<ClaudeRecord & { _organization_uuid: string }> = [];
    for (const organizationId of organizationIds) {
      const rows = await listClaudeConversations(page, organizationId);
      listings.push(...rows.map((row) => ({ ...row, _organization_uuid: organizationId })));
    }

    const output = join(config.dataRoot, "live", "claude-web", "conversations.json");
    const existing = await readJson<ClaudeRecord[]>(output, []);
    const existingById = new Map(existing.flatMap((row) => row.uuid ? [[row.uuid, row] as const] : []));
    const current: ClaudeRecord[] = [];
    let fetched = 0;
    let unchanged = 0;
    for (const listing of deduplicateClaude(listings)) {
      if (!listing.uuid) continue;
      const previous = existingById.get(listing.uuid);
      if (previous && previous.updated_at === listing.updated_at) {
        current.push(previous);
        unchanged += 1;
        existingById.delete(listing.uuid);
        continue;
      }
      const detail = await fetchClaudeConversation(page, listing._organization_uuid, listing.uuid);
      current.push({ ...detail, _organization_uuid: listing._organization_uuid });
      existingById.delete(listing.uuid);
      fetched += 1;
      await delay(150);
    }
    current.push(...existingById.values());
    current.sort((left, right) => String(left.uuid ?? "").localeCompare(String(right.uuid ?? "")));
    await writePrivateJson(output, current);
    return {
      provider: "claude-web",
      discovered: listings.length,
      fetched,
      unchanged,
      retained: existingById.size,
    };
  } finally {
    await context.close();
  }
}

async function listClaudeConversations(page: Page, organizationId: string): Promise<ClaudeRecord[]> {
  const output: ClaudeRecord[] = [];
  const seen = new Set<string>();
  for (let pageNumber = 1; pageNumber <= 1_000; pageNumber += 1) {
    const rows = await page.evaluate(async ({ organizationId, pageNumber }) => {
      const url = `/api/organizations/${encodeURIComponent(organizationId)}/chat_conversations?limit=100&page=${pageNumber}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error(`Claude conversation list failed (${response.status})`);
      const value: unknown = await response.json();
      return Array.isArray(value) ? value as ClaudeRecord[] : [];
    }, { organizationId, pageNumber });
    if (rows.length === 0) break;
    let cycled = false;
    for (const row of rows) {
      if (!row.uuid || seen.has(row.uuid)) {
        cycled = cycled || Boolean(row.uuid);
        continue;
      }
      seen.add(row.uuid);
      output.push(row);
    }
    if (rows.length < 100 || cycled) break;
  }
  return output;
}

async function fetchClaudeConversation(page: Page, organizationId: string, conversationId: string): Promise<ClaudeRecord> {
  return await page.evaluate(async ({ organizationId, conversationId }) => {
    const url = `/api/organizations/${encodeURIComponent(organizationId)}/chat_conversations/${encodeURIComponent(conversationId)}?tree=True&rendering_mode=messages&render_all_tools=true`;
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Claude conversation detail failed (${response.status})`);
    return await response.json() as ClaudeRecord;
  }, { organizationId, conversationId });
}

export function deduplicateClaude<T extends ClaudeRecord>(rows: T[]): T[] {
  const output = new Map<string, T>();
  for (const row of rows) if (row.uuid && !output.has(row.uuid)) output.set(row.uuid, row);
  return [...output.values()];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
