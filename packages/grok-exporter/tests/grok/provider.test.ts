import { describe, expect, it } from "vitest";
import { GROK_PROVIDER } from "../../src/grok/provider";

describe("Grok provider descriptor", () => {
  it("retains the accepted identity, URL construction, and manifest hosts", () => {
    expect(GROK_PROVIDER.id).toBe("grok");
    expect(GROK_PROVIDER.conversationUrl("one/two")).toBe("https://grok.com/c/one%2Ftwo");
    expect(GROK_PROVIDER.manifestHosts).toEqual([
      "https://grok.com/*",
      "https://assets.grok.com/*",
      "https://imagine-public.x.ai/*",
      "https://pbs.twimg.com/*",
      "https://video.twimg.com/*",
    ]);
  });
});
