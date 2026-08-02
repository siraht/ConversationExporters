// Runtime shape adapted from GrokExporter commit 85922d6; requests are operation descriptors, never URLs or headers.
import { validateOperation } from "../chatgpt/endpoints";
import { findProviderTab, installDashboardAction, isTrustedExtensionSender, sendPageRequest } from "@conversation-exporters/shared/extension-runtime";
import { failureResponse, type ApiRequest, type ApiResponse, type FindTabResult, parseApiRequest, requestId } from "./protocol";

installDashboardAction();

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
  return await findProviderTab(["https://chatgpt.com/*"], "Open and sign in to chatgpt.com, then try again.");
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
