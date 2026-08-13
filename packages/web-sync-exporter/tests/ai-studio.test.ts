import { describe, expect, it } from "vitest";
import { parsePromptPage, promptIdentity } from "../src/ai-studio";

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
});
