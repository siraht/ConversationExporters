/** Exhaust a provider cursor without a date/page cutoff. Cycles are failures, not EOF. */
export async function collectInventory<T>(label: string, load: (cursor: string | null) => Promise<{ items: T[]; cursor: string | null }>, identity: (item: T) => string): Promise<T[]> {
  const records = new Map<string, T>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await load(cursor);
    for (const item of page.items) records.set(identity(item), item);
    cursor = page.cursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error(`${label} inventory is incomplete: pagination cursor repeated`);
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return [...records.values()];
}

export function inventoryCursor(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} inventory cursor was malformed`);
  return value;
}

export function claudeRows(value: unknown, label: string, allowId = false): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} inventory format is unsupported; completeness cannot be established`);
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || !(typeof row.uuid === "string" && row.uuid || allowId && typeof row.id === "string" && row.id)) {
      throw new Error(`${label} inventory contains a record without an identity`);
    }
    return row as Record<string, unknown>;
  });
}

export async function fetchClaudeInventory(url: string, label: string, fetcher: typeof fetch = fetch, allowId = false): Promise<Record<string, unknown>[]> {
  return await collectInventory(label, async (cursor) => {
    const current = cursor ?? url;
    const response = await fetcher(current, { credentials: "include", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${label} inventory failed (${response.status})`);
    return { items: claudeRows(await response.json(), label, allowId), cursor: claudeNextLink(response.headers.get("Link"), current) };
  }, (row) => String(row.uuid ?? row.id));
}

/** Follow only provider-issued next links, never guessed offset/cursor parameters. */
export function claudeNextLink(header: string | null, currentUrl: string): string | null {
  if (!header) return null;
  const next = header.split(/,(?=\s*<)/).filter((part) => /;\s*rel\s*=\s*"?next"?(?:\s*;|\s*$)/i.test(part));
  if (!next.length) return null;
  const target = next[0]?.match(/^\s*<([^>]+)>/);
  if (next.length !== 1 || !target) throw new Error("Claude inventory next link was malformed");
  const current = new URL(currentUrl, "https://claude.ai");
  const url = new URL(target[1]!, current);
  if (url.origin !== current.origin || url.pathname !== current.pathname || url.username || url.password || url.hash) throw new Error("Claude inventory next link changed endpoint");
  return url.href;
}
