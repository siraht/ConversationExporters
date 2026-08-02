import { installPageRelay } from "@conversation-exporters/shared/page-relay";
import {
  failureResponse,
  isApiResponse,
  PAGE_REQUEST_CHANNEL,
  PAGE_RESPONSE_CHANNEL,
  parseApiRequest,
  requestId,
  type ApiRequest,
  type ApiResponse,
} from "./protocol";

installPageRelay<ApiRequest, ApiResponse>({
  runtimeMessageType: "CHATGPT_EXPORTER_PAGE_REQUEST",
  requestChannel: PAGE_REQUEST_CHANNEL,
  responseChannel: PAGE_RESPONSE_CHANNEL,
  parseRequest: parseApiRequest,
  isResponse: isApiResponse,
  responseRequestId: (response) => response.requestId,
  invalidResponse: (value) => failureResponse(requestId(value), "INVALID_BRIDGE_REQUEST", "Request failed relay validation."),
  timeoutResponse: (request) => failureResponse(
    request.requestId,
    "PAGE_BRIDGE_TIMEOUT",
    "Timed out waiting for the ChatGPT page bridge.",
    { retryable: true },
  ),
});
