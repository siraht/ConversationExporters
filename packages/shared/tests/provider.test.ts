import { describe, expect, it } from "vitest";
import type { ProviderInventoryPage } from "../src/provider";

describe("provider capability contract", () => {
  it("keeps each provider's cursor evidence opaque", () => {
    const tokenPage: ProviderInventoryPage<"history", string, { id: string }, { envelope: string }> = {
      scope: "history",
      requestedCursor: "token-1",
      nextCursor: "token-2",
      entries: [{ id: "one" }],
      raw: { envelope: "grok" },
      terminal: false,
    };
    const offsetPage: ProviderInventoryPage<"main", { offset: number }, { logicalKey: string }, { envelope: string }> = {
      scope: "main",
      requestedCursor: { offset: 0 },
      nextCursor: { offset: 100 },
      entries: [{ logicalKey: "one" }],
      raw: { envelope: "chatgpt" },
      terminal: false,
    };

    expect(tokenPage.nextCursor).toBe("token-2");
    expect(offsetPage.nextCursor).toEqual({ offset: 100 });
  });
});
