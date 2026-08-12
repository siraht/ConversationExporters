import { describe, expect, it } from "vitest";
import { parseGeminiResponse } from "../src/gemini";

describe("Gemini list protocol", () => {
  it("parses framed cursor pages", () => {
    const inner = JSON.stringify([null, "next", [["c_id", "Title", null, null, null, [1_700_000_000, 0]]]]);
    const outer = JSON.stringify([["wrb.fr", "MaZiqc", inner, null]]);
    expect(parseGeminiResponse(`)]}'\n${outer}`)).toEqual({ cursor: "next", items: [{ id: "id", title: "Title", updated_at: "2023-11-14T22:13:20.000Z" }] });
  });
});
