import type { ApiRequest, ApiResponse } from "../core/types";
import { BRIDGE_PROTOCOL_VERSION } from "../core/types";
import { isApiRequest, PAGE_REQUEST_CHANNEL, PAGE_RESPONSE_CHANNEL } from "./protocol";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const data = message as { type?: string; request?: unknown } | undefined;
  if (data?.type !== "GROK_EXPORTER_PAGE_REQUEST" || !isApiRequest(data.request)) return false;
  relay(data.request).then(sendResponse).catch((error: unknown) => {
    sendResponse({
      requestId: isApiRequest(data.request) ? data.request.requestId : "unknown",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: { name: "RelayError", message: error instanceof Error ? error.message : String(error), retryable: true },
    } satisfies ApiResponse);
  });
  return true;
});

function relay(request: ApiRequest): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the Grok page bridge."));
    }, request.timeoutMs + 5_000);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { channel?: string; response?: ApiResponse } | undefined;
      if (data?.channel !== PAGE_RESPONSE_CHANNEL || data.response?.requestId !== request.requestId) return;
      cleanup();
      resolve(data.response);
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ channel: PAGE_REQUEST_CHANNEL, request }, location.origin);
  });
}

