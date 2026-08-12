import type { ApiResponse } from "../core/types";
import { BRIDGE_PROTOCOL_VERSION } from "../core/types";
import { findProviderTab, installDashboardAction, isTrustedExtensionSender, sendPageRequest } from "@conversation-exporters/shared/extension-runtime";
import { isAllowedGrokApiRequest } from "../grok/endpoints";
import { GROK_PROVIDER } from "../grok/provider";
import type { DashboardRuntimeRequest, FindTabResult, RuntimeApiRequest } from "./protocol";
import { isApiRequest } from "./protocol";

declare const __NATIVE_ARCHIVE__: boolean;

installDashboardAction(__NATIVE_ARCHIVE__ ? "?auto=3600" : "");
if (__NATIVE_ARCHIVE__) installAutomaticDashboard();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender)) return false;
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
  return await findProviderTab([`${GROK_PROVIDER.primaryOrigin}/*`], "Open and sign in to grok.com, then try again.");
}

function installAutomaticDashboard(): void {
  const alarm = "grok-native-sync";
  const ensure = async (): Promise<void> => {
    const url = chrome.runtime.getURL("dashboard.html?auto=3600");
    const tabs = await chrome.tabs.query({});
    if (!tabs.some((tab) => tab.url === url)) await chrome.tabs.create({ url, active: false });
  };
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.alarms.create(alarm, { periodInMinutes: 60 });
    void ensure();
  });
  chrome.runtime.onStartup.addListener(() => { void ensure(); });
  chrome.alarms.onAlarm.addListener((value) => { if (value.name === alarm) void ensure(); });
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
    return await sendPageRequest<ApiResponse>(message.tabId, "GROK_EXPORTER_PAGE_REQUEST", message.request);
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
