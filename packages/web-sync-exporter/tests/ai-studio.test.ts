import { describe, expect, it } from "vitest";
import { parsePromptPage, promptIdentity, promptRequestBody } from "../src/ai-studio";

describe("AI Studio prompt RPC", () => {
  it("parses full prompt records and pagination cursor", () => {
    const result = parsePromptPage([[['prompts/one', null], ['prompts/two', { raw: true }]], 'next']);
    expect(result.prompts).toHaveLength(2);
    expect(result.cursor).toBe('next');
    expect(promptIdentity(result.prompts[0]!)).toBe('prompts/one');
  });

  it("rejects records without provider identity", () => {
    expect(() => promptIdentity([])).toThrow("identity");
  });

  it("replays a captured GetPrompt request without changing opaque fields", () => {
    expect(promptRequestBody(["prompts/example", null, "drive-token"], "prompts/next"))
      .toEqual(["prompts/next", null, "drive-token"]);
  });
});
