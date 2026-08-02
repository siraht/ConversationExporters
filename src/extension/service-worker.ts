import type { ApiResponse } from "../core/types";
import { BRIDGE_PROTOCOL_VERSION } from "../core/types";
import { isAllowedGrokApiRequest } from "../grok/endpoints";
import type { DashboardRuntimeRequest, FindTabResult, RuntimeApiRequest } from "./protocol";
import { isApiRequest } from "./protocol";

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const request = message as DashboardRuntimeRequest;
  if (request.type === "GROK_EXPORTER_FIND_TAB") {
    void findGrokTab().then(sendResponse);
    return true;
  }
  if (request.type === "GROK_EXPORTER_API_REQUEST") {
    void forwardApiRequest(request).then(sendResponse);
    return true;
  }
  return false;
});

async function findGrokTab(): Promise<FindTabResult> {
  const tabs = await chrome.tabs.query({ url: ["https://grok.com/*"] });
  const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
  if (tab?.id === undefined) return { ok: false, error: "Open and sign in to grok.com, then try again." };
  return { ok: true, tabId: tab.id, ...(tab.title === undefined ? {} : { title: tab.title }) };
}

async function forwardApiRequest(message: RuntimeApiRequest): Promise<ApiResponse> {
  if (!Number.isInteger(message.tabId) || !isApiRequest(message.request) || !isAllowedGrokApiRequest(message.request.path, message.request.method)) {
    return {
      requestId: isApiRequest(message.request) ? message.request.requestId : "unknown",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: { name: "ServiceWorkerError", message: "Request failed extension validation.", code: "INVALID_BRIDGE_REQUEST", retryable: false },
    };
  }
  try {
    return await chrome.tabs.sendMessage(message.tabId, {
      type: "GROK_EXPORTER_PAGE_REQUEST",
      request: message.request,
    }) as ApiResponse;
  } catch {
    return {
      requestId: message.request.requestId,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: {
        name: "ServiceWorkerError",
        message: "Could not reach the Grok tab. Reload grok.com and try again.",
        code: "GROK_TAB_UNREACHABLE",
        retryable: true,
      },
    };
  }
}

