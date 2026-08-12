export interface GeminiListItem { id: string; title: string; updated_at: string | null }

export function parseGeminiResponse(text: string): { cursor: string | null; items: GeminiListItem[] } {
  const start = text.indexOf('[["wrb.fr","MaZiqc"');
  if (start < 0) return { cursor: null, items: [] };
  const end = matchingEnd(text, start);
  if (end < 0) return { cursor: null, items: [] };
  try {
    const outer = JSON.parse(text.slice(start, end + 1)) as unknown[][];
    const encoded = outer[0]?.[2];
    if (typeof encoded !== "string") return { cursor: null, items: [] };
    const inner = JSON.parse(encoded) as unknown[];
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
