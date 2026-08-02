export interface RelayRequest {
  requestId: string;
  timeoutMs: number;
}

export interface PageRelayAdapter<Request extends RelayRequest, Response> {
  runtimeMessageType: string;
  requestChannel: string;
  responseChannel: string;
  parseRequest(value: unknown): Request | undefined;
  isResponse(value: unknown): value is Response;
  responseRequestId(response: Response): string;
  invalidResponse?(value: unknown): Response;
  timeoutResponse(request: Request): Response;
}

export function installPageRelay<Request extends RelayRequest, Response>(adapter: PageRelayAdapter<Request, Response>): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const data = message as { type?: string; request?: unknown } | undefined;
    if (data?.type !== adapter.runtimeMessageType) return false;
    let request: Request | undefined;
    try {
      request = adapter.parseRequest(data.request);
    } catch {
      request = undefined;
    }
    if (request === undefined) {
      if (adapter.invalidResponse) sendResponse(adapter.invalidResponse(data.request));
      return false;
    }
    relay(request, adapter).then(sendResponse).catch(() => sendResponse(adapter.timeoutResponse(request!)));
    return true;
  });
}

function relay<Request extends RelayRequest, Response>(
  request: Request,
  adapter: PageRelayAdapter<Request, Response>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, request.timeoutMs + 5_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { channel?: string; response?: unknown } | undefined;
      if (data?.channel !== adapter.responseChannel || !adapter.isResponse(data.response)) return;
      if (adapter.responseRequestId(data.response) !== request.requestId) return;
      cleanup();
      resolve(data.response);
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ channel: adapter.requestChannel, request }, location.origin);
  });
}

