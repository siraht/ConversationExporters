export interface GeminiListItem { id: string; title: string; updated_at: string | null }
export interface GeminiMessage { id: string; role: "user" | "assistant"; content: string }

export interface GeminiDetail {
  messages: GeminiMessage[];
  provider_raw: unknown;
  possibly_truncated: boolean;
}

export function parseGeminiResponse(text: string): { cursor: string | null; items: GeminiListItem[] } {
  try {
    const inner = rpcPayload(text, "MaZiqc");
    if (!inner) return { cursor: null, items: [] };
    const rows = Array.isArray(inner[2]) ? inner[2] : [];
    const items = rows.flatMap((row) => {
      if (!Array.isArray(row)) return [];
      const id = String(row[0] ?? "").replace(/^c_/, "");
      if (!id) return [];
      const updated_at = Array.isArray(row[5]) && typeof row[5][0] === "number" ? new Date(row[5][0] * 1000).toISOString() : null;
      return [{ id, title: String(row[1] ?? "Untitled").trim() || "Untitled", updated_at }];
    });
    return { cursor: typeof inner[1] === "string" ? inner[1] : null, items };
  } catch { return { cursor: null, items: [] }; }
}

export function parseGeminiChatResponse(text: string, conversationId: string, limit: number): GeminiDetail {
  const body = rpcPayload(text, "hNvQHb");
  const turns = body && Array.isArray(body[0]) ? body[0] : [];
  const messages: GeminiMessage[] = [];
  for (const [index, turn] of turns.map((value, index) => [index, value] as const).reverse()) {
    if (!Array.isArray(turn)) continue;
    const user = nested(turn, [2, 0]);
    if (Array.isArray(user)) {
      const content = typeof user[0] === "string" && user[0].trim()
        ? user[0].trim()
        : containsAttachment(user) ? "[User sent an attachment]" : "[Unknown user input]";
      messages.push({ id: `${conversationId}-user-${index}`, role: "user", content });
    }
    const candidates = nested(turn, [3, 0]);
    if (!Array.isArray(candidates)) continue;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      if (!Array.isArray(candidate) || !candidate[0]) continue;
      const textValue = nested(candidate, [1, 0]);
      const content = typeof textValue === "string" && textValue.trim()
        ? textValue.trim()
        : "[Gemini response contained non-text content]";
      messages.push({ id: String(candidate[0] || `${conversationId}-assistant-${index}-${candidateIndex}`), role: "assistant", content });
    }
  }
  return { messages, provider_raw: body, possibly_truncated: turns.length >= limit };
}

export function rpcPayload(text: string, rpcId: string): unknown[] | undefined {
  const marker = `[["wrb.fr","${rpcId}"`;
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  const end = matchingEnd(text, start);
  if (end < 0) return undefined;
  const outer = JSON.parse(text.slice(start, end + 1)) as unknown[][];
  const encoded = outer[0]?.[2];
  return typeof encoded === "string" ? JSON.parse(encoded) as unknown[] : undefined;
}

function nested(value: unknown, path: number[]): unknown {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

function containsAttachment(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length > 11 && typeof value[2] === "string" && value[2].includes(".")) return true;
  return value.some(containsAttachment);
}

function matchingEnd(text: string, start: number): number {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}
