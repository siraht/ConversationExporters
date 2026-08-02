import { describe, expect, it } from "vitest";
import { CHATGPT_PROVIDER } from "../../src/chatgpt/provider";

describe("ChatGPT provider descriptor", () => {
  it("retains the accepted identity, URL construction, and manifest hosts", () => {
    expect(CHATGPT_PROVIDER.id).toBe("chatgpt-web");
    expect(CHATGPT_PROVIDER.conversationUrl("one/two")).toBe("https://chatgpt.com/c/one%2Ftwo");
    expect(CHATGPT_PROVIDER.manifestHosts).toEqual(["https://chatgpt.com/*"]);
  });
});
