import { describe, expect, it } from "vitest";
import { claudeNextLink, claudeRows, collectInventory, fetchClaudeInventory } from "../src/inventory";
import { parseGeminiResponse } from "../src/gemini";
import { parsePromptPage } from "../src/ai-studio";

describe("inventory exhaustion", () => {
  it("continues past the former 200-page cutoff", async () => {
    let calls = 0;
    const rows = await collectInventory("test", async () => {
      calls += 1;
      return { items: [String(calls)], cursor: calls < 205 ? String(calls) : null };
    }, (id) => id);
    expect(rows).toHaveLength(205);
    expect(calls).toBe(205);
  });
  it("rejects immediate and multi-page cursor cycles", async () => {
    for (const sequence of [["a", "a"], ["a", "b", "a"]]) {
      let index = 0;
      await expect(collectInventory("test", async () => ({ items: [], cursor: sequence[index++]! }), String)).rejects.toThrow("incomplete");
    }
  });
  it("propagates a later-page failure instead of returning earlier records", async () => {
    await expect(collectInventory("test", async (cursor) => {
      if (cursor) throw new Error("HTTP 403");
      return { items: ["one"], cursor: "next" };
    }, String)).rejects.toThrow("403");
  });
  it("accepts explicit empty pages and follows their continuation", async () => {
    expect(await collectInventory("test", async (cursor) => cursor ? { items: ["one"], cursor: null } : { items: [], cursor: "next" }, String)).toEqual(["one"]);
  });
});

describe("strict provider inventory parsing", () => {
  const frame = (value: unknown) => JSON.stringify([["wrb.fr", "MaZiqc", JSON.stringify(value), null]]);
  it("does not treat HTML, missing RPCs, malformed records or cursors as Gemini EOF", () => {
    for (const value of ["<!DOCTYPE html>", "[]", frame({}), frame([null, null, [null]]), frame([null, 12, []])]) {
      expect(() => parseGeminiResponse(value)).toThrow();
    }
    expect(parseGeminiResponse(frame([null, null, []]))).toEqual({ items: [], cursor: null });
  });
  it("rejects malformed AI Studio rows and cursors instead of dropping them", () => {
    for (const value of [{}, [[null]], [[[""]]], [[], 12]]) expect(() => parsePromptPage(value)).toThrow();
    expect(parsePromptPage([[], null])).toEqual({ prompts: [], cursor: null });
  });
  it("rejects unknown Claude envelopes and malformed organizations or conversations", () => {
    for (const value of [{ data: [] }, [null], [{}], [{ uuid: 12 }]]) expect(() => claudeRows(value, "Claude")).toThrow();
    expect(claudeRows([], "Claude")).toEqual([]);
  });
  it("uses provider next links and refuses endpoint changes", () => {
    const url = "https://claude.ai/api/organizations/org/chat_conversations";
    expect(claudeNextLink('<?cursor=abc>; rel="next"', url)).toBe(`${url}?cursor=abc`);
    expect(claudeNextLink(null, url)).toBeNull();
    expect(() => claudeNextLink('<https://evil.test/>; rel="next"', url)).toThrow();
    expect(() => claudeNextLink('</other>; rel="next"', url)).toThrow();
  });
  it("collects Claude project/docs pages and surfaces later failures", async () => {
    const url = "https://claude.ai/api/organizations/org/projects";
    const requested: string[] = [];
    const fetcher = (async (input) => {
      requested.push(String(input));
      return requested.length === 1
        ? new Response(JSON.stringify([{ id: "one" }]), { headers: { Link: '<?cursor=two>; rel="next"' } })
        : new Response(JSON.stringify([{ id: "two" }]));
    }) as typeof fetch;
    expect(await fetchClaudeInventory(url, "Claude projects", fetcher, true)).toHaveLength(2);
    expect(requested).toEqual([url, `${url}?cursor=two`]);
    await expect(fetchClaudeInventory(url, "Claude projects", (async () => new Response("blocked", { status: 403 })) as typeof fetch)).rejects.toThrow("403");
  });
});
