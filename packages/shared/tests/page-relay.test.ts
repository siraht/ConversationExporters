import { afterEach, describe, expect, it, vi } from "vitest";
import { installPageRelay } from "../src/page-relay";

interface Request {
  requestId: string;
  timeoutMs: number;
}

interface Response {
  requestId: string;
  ok: boolean;
}

afterEach(() => vi.unstubAllGlobals());

describe("shared page relay", () => {
  it("validates requests and relays only matching same-origin responses", async () => {
    let runtimeListener: ((message: unknown, sender: unknown, respond: (response: Response) => void) => boolean) | undefined;
    let pageListener: ((event: MessageEvent) => void) | undefined;
    const fakeWindow = {
      addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => { pageListener = listener; }),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      postMessage: vi.fn((message: { request: Request }) => {
        pageListener?.({
          source: fakeWindow,
          origin: "https://provider.example",
          data: { channel: "response", response: { requestId: message.request.requestId, ok: true } },
        } as unknown as MessageEvent);
      }),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("location", { origin: "https://provider.example" });
    vi.stubGlobal("chrome", {
      runtime: { onMessage: { addListener: (listener: typeof runtimeListener) => { runtimeListener = listener; } } },
    });

    installPageRelay<Request, Response>({
      runtimeMessageType: "REQUEST",
      requestChannel: "request",
      responseChannel: "response",
      parseRequest: (value) => isRequest(value) ? value : undefined,
      isResponse: (value): value is Response => typeof value === "object" && value !== null && typeof (value as Response).requestId === "string",
      responseRequestId: (response) => response.requestId,
      invalidResponse: () => ({ requestId: "invalid", ok: false }),
      timeoutResponse: (request) => ({ requestId: request.requestId, ok: false }),
    });

    const respond = vi.fn();
    expect(runtimeListener?.({ type: "REQUEST", request: { requestId: "one", timeoutMs: 10 } }, {}, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ requestId: "one", ok: true }));
    expect(fakeWindow.postMessage).toHaveBeenCalledWith({
      channel: "request",
      request: { requestId: "one", timeoutMs: 10 },
    }, "https://provider.example");

    const reject = vi.fn();
    expect(runtimeListener?.({ type: "REQUEST", request: {} }, {}, reject)).toBe(false);
    expect(reject).toHaveBeenCalledWith({ requestId: "invalid", ok: false });
  });
});

function isRequest(value: unknown): value is Request {
  return typeof value === "object" && value !== null
    && typeof (value as Request).requestId === "string"
    && typeof (value as Request).timeoutMs === "number";
}
