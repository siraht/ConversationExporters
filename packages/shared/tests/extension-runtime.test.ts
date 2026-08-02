import { afterEach, describe, expect, it, vi } from "vitest";
import { findProviderTab, installDashboardAction, isTrustedExtensionSender, sendPageRequest } from "../src/extension-runtime";

afterEach(() => vi.unstubAllGlobals());

describe("shared extension runtime", () => {
  it("selects the active provider tab and forwards typed page requests", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const query = vi.fn().mockResolvedValue([
      { id: 1, title: "inactive", active: false },
      { id: 2, title: "active", active: true },
    ]);
    stubChrome({ query, sendMessage });

    await expect(findProviderTab(["https://provider.example/*"], "missing")).resolves.toEqual({
      ok: true,
      tabId: 2,
      title: "active",
    });
    await expect(sendPageRequest(2, "REQUEST", { value: 1 })).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith({ url: ["https://provider.example/*"] });
    expect(sendMessage).toHaveBeenCalledWith(2, { type: "REQUEST", request: { value: 1 } });
  });

  it("rejects non-extension senders and opens the local dashboard", () => {
    const addListener = vi.fn();
    const create = vi.fn();
    stubChrome({ addListener, create });

    expect(isTrustedExtensionSender({ id: "extension", url: "chrome-extension://extension/dashboard.html" })).toBe(true);
    expect(isTrustedExtensionSender({ id: "other", url: "chrome-extension://extension/dashboard.html" })).toBe(false);

    installDashboardAction();
    const listener = addListener.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(listener).toBeTypeOf("function");
    listener?.();
    expect(create).toHaveBeenCalledWith({ url: "chrome-extension://extension/dashboard.html" });
  });
});

function stubChrome(overrides: {
  addListener?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  query?: ReturnType<typeof vi.fn>;
  sendMessage?: ReturnType<typeof vi.fn>;
}): void {
  vi.stubGlobal("chrome", {
    action: { onClicked: { addListener: overrides.addListener ?? vi.fn() } },
    runtime: {
      id: "extension",
      getURL: (path: string) => `chrome-extension://extension/${path}`,
    },
    tabs: {
      create: overrides.create ?? vi.fn(),
      query: overrides.query ?? vi.fn(),
      sendMessage: overrides.sendMessage ?? vi.fn(),
    },
  });
}
