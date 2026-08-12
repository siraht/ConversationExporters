import { describe, expect, it } from "vitest";
import { deduplicateClaude } from "../src/claude.js";
import { parseGeminiListResponse } from "../src/gemini.js";

describe("Claude capture", () => {
  it("deduplicates cycling list pages by native UUID", () => {
    expect(deduplicateClaude([{ uuid: "one" }, { uuid: "two" }, { uuid: "one" }])).toEqual([
      { uuid: "one" },
      { uuid: "two" },
    ]);
  });
});

describe("Gemini capture", () => {
  it("parses the framed MaZiqc response without depending on chunk lengths", () => {
    const inner = JSON.stringify([null, "next-page", [["c_abc123", "A title", null, null, null, [1_700_000_000, 0]]]]);
    const outer = JSON.stringify([["wrb.fr", "MaZiqc", inner, null]]);
    const result = parseGeminiListResponse(`)]}'\n${outer}\n`);
    expect(result).toEqual({
      cursor: "next-page",
      items: [{ id: "abc123", title: "A title", updated_at: "2023-11-14T22:13:20.000Z" }],
    });
  });

  it("fails closed on malformed responses", () => {
    expect(parseGeminiListResponse("not a batch response")).toEqual({ cursor: null, items: [] });
  });
});
