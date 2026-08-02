// Relay shape adapted from GrokExporter commit 85922d6; it validates the typed request before crossing page worlds.
import { failureResponse, isApiResponse, PAGE_REQUEST_CHANNEL, PAGE_RESPONSE_CHANNEL, parseApiRequest, requestId, type ApiRequest, type ApiResponse } from "./protocol";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const data = message as { type?: string; request?: unknown } | undefined;
  if (data?.type !== "CHATGPT_EXPORTER_PAGE_REQUEST") return false;
  let request: ApiRequest;
  try {
    request = parseApiRequest(data.request);
  } catch {
    sendResponse(failureResponse(requestId(data.request), "INVALID_BRIDGE_REQUEST", "Request failed relay validation."));
    return false;
  }
  relay(request).then(sendResponse).catch(() => {
    sendResponse(failureResponse(request.requestId, "PAGE_BRIDGE_TIMEOUT", "Timed out waiting for the ChatGPT page bridge.", {
      retryable: true,
    }));
  });
  return true;
});

function relay(request: ApiRequest): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, request.timeoutMs + 5_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { channel?: string; response?: unknown } | undefined;
      if (data?.channel !== PAGE_RESPONSE_CHANNEL || !isApiResponse(data.response) || data.response.requestId !== request.requestId) return;
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
