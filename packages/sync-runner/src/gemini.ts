import { join } from "node:path";
import type { Page } from "playwright";
import { launchProviderBrowser } from "./browser.js";
import { readJson, writePrivateJson } from "./files.js";
import type { CaptureSummary } from "./claude.js";
import type { SyncConfig } from "./types.js";

export interface GeminiListing {
  id: string;
  title: string;
  updated_at: string | null;
}

export interface GeminiConversation extends GeminiListing {
  messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
}

export async function captureGemini(config: SyncConfig, headed = false): Promise<CaptureSummary> {
  const context = await launchProviderBrowser(config, "gemini", headed);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const listings = await listGeminiConversations(page);
    const output = join(config.dataRoot, "live", "gemini-web", "conversations.json");
    const existingDocument = await readJson<{ conversations: GeminiConversation[] }>(output, { conversations: [] });
    const existing = new Map(existingDocument.conversations.map((conversation) => [conversation.id, conversation]));
    const conversations: GeminiConversation[] = [];
    let fetched = 0;
    let unchanged = 0;
    for (const listing of listings) {
      const previous = existing.get(listing.id);
      if (previous && previous.updated_at === listing.updated_at) {
        conversations.push(previous);
        existing.delete(listing.id);
        unchanged += 1;
        continue;
      }
      conversations.push(await fetchGeminiConversation(page, listing));
      existing.delete(listing.id);
      fetched += 1;
      await page.waitForTimeout(1_250);
    }
    conversations.push(...existing.values());
    conversations.sort((left, right) => left.id.localeCompare(right.id));
    await writePrivateJson(output, { conversations });
    return {
      provider: "gemini-web",
      discovered: listings.length,
      fetched,
      unchanged,
      retained: existing.size,
    };
  } finally {
    await context.close();
  }
}

export async function listGeminiConversations(page: Page): Promise<GeminiListing[]> {
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (page.url().includes("accounts.google.com")) throw new Error("Gemini sign-in is required; run conversation-sync login gemini");
  if (page.url().includes("google.com/sorry")) throw new Error("Google CAPTCHA is active; complete it in a headed Gemini login session");
  const session = await page.evaluate(() => {
    const wiz = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data ?? {};
    return { sid: String(wiz.FdrFJe ?? ""), bl: String(wiz.cfb2h ?? ""), at: String(wiz.SNlM0e ?? "") };
  });
  if (!session.sid || !session.bl || !session.at) throw new Error("Gemini session parameters were unavailable");

  const rows: GeminiListing[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
    const argument = cursor === null ? [13, null, [0, null, 1]] : [20, cursor, [0, null, 1]];
    const request = JSON.stringify([[['MaZiqc', JSON.stringify(argument), null, 'generic']]]);
    const response = await geminiBatchExecute(page, session, request);
    const parsed = parseGeminiListResponse(response);
    rows.push(...parsed.items);
    if (!parsed.cursor || parsed.cursor === cursor || seenCursors.has(parsed.cursor)) break;
    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }
  const deduplicated = new Map<string, GeminiListing>();
  for (const row of rows) if (!deduplicated.has(row.id)) deduplicated.set(row.id, row);
  return [...deduplicated.values()];
}

async function geminiBatchExecute(
  page: Page,
  session: { sid: string; bl: string; at: string },
  request: string,
): Promise<string> {
  return await page.evaluate(async ({ session, request }) => {
    const url = `/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&source-path=%2Fapp&bl=${encodeURIComponent(session.bl)}&f.sid=${encodeURIComponent(session.sid)}&hl=en&_reqid=${Math.floor(Math.random() * 900000) + 100000}&rt=c`;
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" },
      body: `f.req=${encodeURIComponent(request)}&at=${encodeURIComponent(session.at)}`,
    });
    if (!response.ok) throw new Error(`Gemini conversation list failed (${response.status})`);
    return await response.text();
  }, { session, request });
}

export function parseGeminiListResponse(text: string): { cursor: string | null; items: GeminiListing[] } {
  const start = text.indexOf('[["wrb.fr","MaZiqc"');
  if (start < 0) return { cursor: null, items: [] };
  const end = matchingJsonEnd(text, start);
  if (end < 0) return { cursor: null, items: [] };
  try {
    const outer = JSON.parse(text.slice(start, end + 1)) as unknown[][];
    const encoded = outer[0]?.[2];
    if (typeof encoded !== "string") return { cursor: null, items: [] };
    const inner = JSON.parse(encoded) as unknown[];
    const cursor = typeof inner[1] === "string" ? inner[1] : null;
    const rawItems = Array.isArray(inner[2]) ? inner[2] : [];
    const items: GeminiListing[] = [];
    for (const raw of rawItems) {
      if (!Array.isArray(raw)) continue;
      const id = String(raw[0] ?? "").replace(/^c_/, "");
      if (!id) continue;
      const timestamp = Array.isArray(raw[5]) && typeof raw[5][0] === "number"
        ? new Date(raw[5][0] * 1_000).toISOString()
        : null;
      items.push({ id, title: String(raw[1] ?? "Untitled").trim() || "Untitled", updated_at: timestamp });
    }
    return { cursor, items };
  } catch {
    return { cursor: null, items: [] };
  }
}

async function fetchGeminiConversation(page: Page, listing: GeminiListing): Promise<GeminiConversation> {
  await page.goto(`https://gemini.google.com/app/${encodeURIComponent(listing.id)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (page.url().includes("google.com/sorry")) throw new Error("Google CAPTCHA interrupted Gemini capture");
  if (!page.url().includes(`/app/${listing.id}`)) throw new Error("Gemini conversation was unavailable during capture");
  await page.waitForSelector("user-query, model-response, [data-role='user'], [data-role='model']", { state: "attached", timeout: 30_000 });
  const messages = await page.evaluate((conversationId) => {
    const pairs = [
      ...Array.from(document.querySelectorAll("user-query, [data-role='user'], .user-query-container")).map((element) => ({ element, role: "user" as const })),
      ...Array.from(document.querySelectorAll("model-response, [data-role='model'], .model-response-text")).map((element) => ({ element, role: "assistant" as const })),
    ].sort((left, right) => left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return pairs.flatMap(({ element, role }, index) => {
      const content = element.textContent?.trim();
      return content ? [{ id: `${conversationId}-${index}`, role, content }] : [];
    });
  }, listing.id);
  return { ...listing, messages };
}

function matchingJsonEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
