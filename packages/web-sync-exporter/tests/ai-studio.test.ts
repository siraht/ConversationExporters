import { describe, expect, it } from "vitest";
import {
  locatePromptReference,
  parsePromptPage,
  promptIdentity,
  promptReferenceAt,
  promptRequestBody,
  promptRpcKind,
} from "../src/ai-studio";

describe("AI Studio prompt RPC", () => {
  it("parses full prompt records and pagination cursor", () => {
    const result = parsePromptPage([[['prompts/one', null], ['prompts/two', { raw: true }]], 'next']);
    expect(result.prompts).toHaveLength(2);
    expect(result.cursor).toBe('next');
    expect(promptIdentity(result.prompts[0]!)).toBe('prompts/one');
  });

  it("parses the current numeric-key protobuf JSON response", () => {
    const result = parsePromptPage({ "0": [["prompts/one"], ["prompts/two"]], "1": "next" });
    expect(result.prompts).toHaveLength(2);
    expect(result.cursor).toBe("next");
  });

  it("rejects records without provider identity", () => {
    expect(() => promptIdentity([])).toThrow("identity");
  });

  it("replays a captured GetPrompt request without changing opaque fields", () => {
    expect(promptRequestBody(["prompts/example", null, "drive-token"], "prompts/next"))
      .toEqual(["prompts/next", null, "drive-token"]);
    expect(promptRequestBody({ "0": "prompts/example", "2": "opaque" }, "prompts/next"))
      .toEqual({ "0": "prompts/next", "2": "opaque" });
  });

  it("recognizes the current Alkali RPC endpoint shape", () => {
    expect(promptRpcKind("https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts"))
      .toBe("list");
    expect(promptRpcKind("https://example.test/$rpc/v1.MakerSuiteService/GetPrompt"))
      .toBe("get");
    expect(promptRpcKind("https://example.test/$rpc/v1.MakerSuiteService/ResolveDriveResource"))
      .toBe("get");
  });

  it("maps the captured Drive reference to the same field in every inventory record", () => {
    const records = [
      ["prompts/one", null, { drive: "drive://opened-id" }],
      ["prompts/two", null, { drive: "drive://next-id" }],
    ];
    const locator = locatePromptReference(records, "opened-id");
    expect(locator).toEqual({ path: [2, "drive"], prefix: "drive://", suffix: "" });
    expect(promptReferenceAt(records[1]!, locator!)).toBe("next-id");
  });

  it("does not guess a Drive reference when the opened prompt is absent", () => {
    expect(locatePromptReference([["prompts/one"]], "missing-id")).toBeNull();
  });
});
