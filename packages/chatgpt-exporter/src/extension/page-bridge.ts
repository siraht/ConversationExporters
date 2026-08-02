import { PageAuthenticationError, PageLocalAuth } from "../chatgpt/auth";
import { AssetSessionError, PageAssetSessions } from "../chatgpt/asset-session";
import { resolveEndpoint, validateOperation } from "../chatgpt/endpoints";
import {
  BRIDGE_PROTOCOL_VERSION,
  failureResponse,
  isJsonValue,
  PAGE_REQUEST_CHANNEL,
  PAGE_RESPONSE_CHANNEL,
  parseApiRequest,
  requestId,
  type ApiRequest,
  type ApiResponse,
  type ApiSuccessResponse,
} from "./protocol";

const auth = new PageLocalAuth();
const assetSessions = new PageAssetSessions();

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as { channel?: string; request?: unknown } | undefined;
  if (data?.channel !== PAGE_REQUEST_CHANNEL) return;
  let request: ApiRequest;
  try {
    request = parseApiRequest(data.request);
    validateOperation(request);
  } catch {
    post(failureResponse(requestId(data.request), "INVALID_BRIDGE_REQUEST", "Request rejected by the page-world allowlist."));
    return;
  }
  void execute(request).then(post);
});

async function execute(request: ApiRequest): Promise<ApiResponse> {
  const correlationId = crypto.randomUUID();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    if (request.operation === "session_probe") {
      const metadata = await auth.probe(controller.signal);
      return success(request, 200, metadata, correlationId);
    }
    if (request.operation === "asset_chunk") {
      return success(request, 200, await assetSessions.chunk(request.parameters.handleId, request.parameters.offset, request.parameters.length, controller.signal), correlationId);
    }
    if (request.operation === "asset_close") {
      return success(request, 200, assetSessions.close(request.parameters.handleId), correlationId);
    }
    const endpoint = resolveEndpoint(request);
    const authorization = await auth.authorizationHeaders(request.workspaceId, controller.signal);
    const response = await fetch(endpoint.path, {
      method: endpoint.method,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...authorization,
        ...(endpoint.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(endpoint.body === undefined ? {} : { body: JSON.stringify(endpoint.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    const responseBytes = new TextEncoder().encode(text).byteLength;
    if (responseBytes > endpoint.responseLimitBytes) {
      return failureResponse(request.requestId, "RESPONSE_TOO_LARGE", "ChatGPT response exceeded the adapter's safety limit.", {
        status: response.status,
        responseBytes,
        correlationId,
      });
    }
    if (!response.ok) {
      if (response.status === 401) auth.clear();
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      return failureResponse(request.requestId, httpCode(response.status), `ChatGPT request failed with HTTP ${response.status}.`, {
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        responseBytes,
        correlationId,
      });
    }
    if (auth.containsCurrentToken(text)) {
      return failureResponse(request.requestId, "SECRET_IN_RESPONSE", "ChatGPT response contained authentication material and was blocked.", {
        status: response.status,
        responseBytes,
        correlationId,
      });
    }
    let body: unknown;
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      return failureResponse(request.requestId, "INVALID_JSON_RESPONSE", "ChatGPT returned invalid JSON.", {
        status: response.status,
        responseBytes,
        correlationId,
      });
    }
    if (!isJsonValue(body)) {
      return failureResponse(request.requestId, "INVALID_JSON_RESPONSE", "ChatGPT returned an unsupported JSON value.", {
        status: response.status,
        responseBytes,
        correlationId,
      });
    }
    const output = request.operation === "asset_open" ? assetSessions.open(body) : body;
    return success(request, response.status, output, correlationId, responseBytes);
  } catch (error) {
    if (error instanceof PageAuthenticationError) {
      return failureResponse(request.requestId, error.code, error.message, {
        ...(error.status === undefined ? {} : { status: error.status }),
        correlationId,
      });
    }
    if (error instanceof AssetSessionError) {
      return failureResponse(request.requestId, error.code, error.message, { retryable: error.retryable, correlationId });
    }
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return failureResponse(request.requestId, timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", timedOut
      ? "ChatGPT request timed out."
      : "ChatGPT request failed before a response was received.", { retryable: true, correlationId });
  } finally {
    window.clearTimeout(timeout);
  }
}

function success(request: ApiRequest, status: number, body: unknown, correlationId: string, responseBytes?: number): ApiSuccessResponse {
  if (!isJsonValue(body)) throw new Error("success body must be JSON");
  const byteCount = responseBytes ?? new TextEncoder().encode(JSON.stringify(body)).byteLength;
  return {
    requestId: request.requestId,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ok: true,
    status,
    body,
    responseBytes: byteCount,
    correlationId,
  };
}

function post(response: ApiResponse): void {
  window.postMessage({ channel: PAGE_RESPONSE_CHANNEL, response }, location.origin);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 3_600_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), 3_600_000));
}

function httpCode(status: number): string {
  if (status === 401) return "AUTHENTICATION_REQUIRED";
  if (status === 403) return "WORKSPACE_FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  return "CHATGPT_HTTP_ERROR";
}
