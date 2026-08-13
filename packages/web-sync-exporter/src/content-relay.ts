import type { PageReply, PageRequest } from "./protocol";

const requestChannel = "conversation-sync:page-request:v2";
const responseChannel = "conversation-sync:page-response:v2";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as PageRequest;
  if (request?.type !== "WEB_SYNC_PAGE_REQUEST_V2" || typeof request.requestId !== "string") return false;
  const listener = (event: MessageEvent) => {
    const data = event.data as { channel?: string; reply?: PageReply } | undefined;
    if (event.source !== window || data?.channel !== responseChannel || data.reply?.requestId !== request.requestId) return;
    window.removeEventListener("message", listener);
    sendResponse(data.reply);
  };
  window.addEventListener("message", listener);
  window.postMessage({ channel: requestChannel, request }, location.origin);
  return true;
});
