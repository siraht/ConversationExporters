// Runtime shape adapted from GrokExporter commit 85922d6; requests are operation descriptors, never URLs or headers.
import { validateOperation } from "../chatgpt/endpoints";
import { CHATGPT_PROVIDER } from "../chatgpt/provider";
import { findProviderTab, installDashboardAction, isTrustedExtensionSender, sendPageRequest } from "@conversation-exporters/shared/extension-runtime";
import { failureResponse, type ApiRequest, type ApiResponse, type FindTabResult, parseApiRequest, requestId } from "./protocol";

declare const __NATIVE_ARCHIVE__: boolean;

installDashboardAction(__NATIVE_ARCHIVE__ ? "?auto=3600" : "");
if (__NATIVE_ARCHIVE__) installAutomaticDashboard();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender)) return false;
  const request = message as { type?: string; tabId?: unknown; request?: unknown } | undefined;
  if (request?.type === "CHATGPT_EXPORTER_FIND_TAB") {
    void findChatGptTab().then(sendResponse);
    return true;
  }
  if (request?.type === "CHATGPT_EXPORTER_API_REQUEST") {
    void forwardApiRequest(request.tabId, request.request).then(sendResponse);
    return true;
  }
  return false;
});

async function findChatGptTab(): Promise<FindTabResult> {
  return await findProviderTab([`${CHATGPT_PROVIDER.primaryOrigin}/*`], "Open and sign in to chatgpt.com, then try again.");
}

function installAutomaticDashboard(): void {
  const alarm = "chatgpt-native-sync";
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

async function forwardApiRequest(tabId: unknown, value: unknown): Promise<ApiResponse> {
  let request: ApiRequest;
  try {
    request = parseApiRequest(value);
    validateOperation(request);
    if (!Number.isInteger(tabId)) throw new Error("tabId is invalid");
  } catch (error) {
    return failureResponse(requestId(value), "INVALID_BRIDGE_REQUEST", validationFailureMessage(error));
  }
  try {
    return await sendPageRequest<ApiResponse>(tabId as number, "CHATGPT_EXPORTER_PAGE_REQUEST", request);
  } catch {
    return failureResponse(request.requestId, "CHATGPT_TAB_UNREACHABLE", "Could not reach the ChatGPT tab. Reload chatgpt.com and try again.", {
      retryable: true,
    });
  }
}

function validationFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed extension validation (unknown error).";
  const reason = error.message.replace(/[^A-Za-z0-9 .,():_-]/g, "?").slice(0, 160);
  return `Request failed extension validation (${error.name}: ${reason || "no detail"}).`;
}
