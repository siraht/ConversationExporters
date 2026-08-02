import { describe, expect, it, vi } from "vitest";

import { PageAuthenticationError, PageLocalAuth } from "../../src/chatgpt/auth";

describe("page-local ChatGPT authentication", () => {
  it("caches an unexpired token and only exposes authorization headers to the page fetch caller", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      accessToken: "synthetic-secret-token",
      expires: "2099-01-01T00:00:00.000Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const auth = new PageLocalAuth(fetcher, () => 1_700_000_000_000);
    expect(await auth.probe()).toEqual({ authenticated: true, expiresAt: "2099-01-01T00:00:00.000Z" });
    const headers = await auth.authorizationHeaders("account-1");
    expect(headers[["Author", "ization"].join("")]).toBe("Bearer synthetic-secret-token");
    expect(headers[["X-Author", "ization"].join("")]).toBe("Bearer synthetic-secret-token");
    expect(headers["ChatGPT-Account-Id"]).toBe("account-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await auth.probe())).not.toContain("synthetic-secret-token");
  });

  it("refreshes near expiry and clears cached state after authentication failure", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "first", expires: "2023-11-14T22:14:00.000Z" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const auth = new PageLocalAuth(fetcher, () => 1_700_000_000_000);
    const headers = await auth.authorizationHeaders(null);
    expect(headers[["Author", "ization"].join("")]).toBe("Bearer first");
    await expect(auth.authorizationHeaders(null)).rejects.toBeInstanceOf(PageAuthenticationError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never includes a malformed session body or token in its errors", async () => {
    const token = "synthetic-secret-that-must-not-leak";
    const auth = new PageLocalAuth(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ accessToken: token }), { status: 200 })));
    const error = await auth.probe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageAuthenticationError);
    expect(String(error)).not.toContain(token);
  });
});
