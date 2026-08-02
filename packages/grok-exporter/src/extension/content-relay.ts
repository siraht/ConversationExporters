import { installPageRelay } from "@conversation-exporters/shared/page-relay";
import type { ApiRequest, ApiResponse } from "../core/types";
import { BRIDGE_PROTOCOL_VERSION } from "../core/types";
import { isApiRequest, PAGE_REQUEST_CHANNEL, PAGE_RESPONSE_CHANNEL } from "./protocol";

installPageRelay<ApiRequest, ApiResponse>({
  runtimeMessageType: "GROK_EXPORTER_PAGE_REQUEST",
  requestChannel: PAGE_REQUEST_CHANNEL,
  responseChannel: PAGE_RESPONSE_CHANNEL,
  parseRequest: (value) => isApiRequest(value) ? value : undefined,
  isResponse: (value): value is ApiResponse => typeof value === "object" && value !== null && typeof (value as { requestId?: unknown }).requestId === "string",
  responseRequestId: (response) => response.requestId,
  timeoutResponse: (request) => ({
    requestId: request.requestId,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ok: false,
    error: { name: "RelayError", message: "Timed out waiting for the Grok page bridge.", retryable: true },
  }),
});

