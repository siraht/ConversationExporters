import { describe, expect, it } from "vitest";
import { parseGeminiChatResponse, parseGeminiResponse } from "../src/gemini";

describe("Gemini list protocol", () => {
  it("parses framed cursor pages", () => {
    const inner = JSON.stringify([null, "next", [["c_id", "Title", null, null, null, [1_700_000_000, 0]]]]);
    const outer = JSON.stringify([["wrb.fr", "MaZiqc", inner, null]]);
    expect(parseGeminiResponse(`)]}'\n${outer}`)).toEqual({ cursor: "next", items: [{ id: "id", title: "Title", updated_at: "2023-11-14T22:13:20.000Z" }] });
  });
});

describe("Gemini read-chat protocol", () => {
  const frame = (value: unknown) => JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(value), null]]);
  it("flags the requested turn ceiling as incomplete and retains every supplied candidate", () => {
    const turn = [null, null, [["question"]], [[["a", ["answer A"]], ["b", ["answer B"]]]]];
    const parsed = parseGeminiChatResponse(frame([[turn]]), "chat", 1);
    expect(parsed.possibly_truncated).toBe(true);
    expect(parsed.messages.map((item) => item.content)).toEqual(["question", "answer A", "answer B"]);
  });
  it("does not normalize malformed detail responses into apparently complete content", () => {
    for (const value of ["<!DOCTYPE html>", frame({}), frame([[null]]), frame([[[null, null, [["q"]], [[[null]]]]]])]) {
      expect(() => parseGeminiChatResponse(value, "chat", 1000)).toThrow();
    }
  });
  it("normalizes newest-first RPC turns into chronological messages and retains the raw payload", () => {
    const older = [null, null, [["older user"]], [[[
      "older-model-id", ["older answer"], null, null, null, null, null, null, [2],
    ]]]];
    const newer = [null, null, [["newer user"]], [[[
      "newer-model-id", ["newer answer"], null, null, null, null, null, null, [2],
    ]]]];
    const inner = [[newer, older]];
    const outer = JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(inner), null]]);
    const parsed = parseGeminiChatResponse(`)]}'\n${outer}`, "chat-id", 1000);
    expect(parsed.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "older user" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "newer user" },
      { role: "assistant", content: "newer answer" },
    ]);
    expect(parsed.provider_raw).toEqual(inner);
    expect(parsed.possibly_truncated).toBe(false);
  });
});
