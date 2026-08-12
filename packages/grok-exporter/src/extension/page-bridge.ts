import { sanitizeError } from "../core/errors";
import { parseRetryAfter } from "../core/retry";
import { BRIDGE_PROTOCOL_VERSION, type ApiFailureResponse, type ApiRequest, type ApiResponse, type ApiSuccessResponse, type JsonValue } from "../core/types";
import { isAllowedGrokApiRequest } from "../grok/endpoints";
import { isApiRequest, isJsonValue, PAGE_REQUEST_CHANNEL, PAGE_RESPONSE_CHANNEL } from "./protocol";

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as { channel?: string; request?: unknown } | undefined;
  if (data?.channel !== PAGE_REQUEST_CHANNEL || !isApiRequest(data.request)) return;
  void execute(data.request).then((response) => {
    window.postMessage({ channel: PAGE_RESPONSE_CHANNEL, response }, location.origin);
  });
});

async function execute(request: ApiRequest): Promise<ApiResponse> {
  if (!isAllowedGrokApiRequest(request.path, request.method)) {
    return failure(request.requestId, "Request rejected by the Grok endpoint allowlist.", "ENDPOINT_NOT_ALLOWED");
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const hasBody = request.method === "POST" && request.body !== undefined;
    const response = await fetch(new URL(request.path, location.origin), {
      method: request.method,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    const responseBytes = new TextEncoder().encode(text).byteLength;
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      return {
        requestId: request.requestId,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        ok: false,
        status: response.status,
        error: {
          name: "GrokHttpError",
          message: `Grok API request failed with HTTP ${response.status}.`,
          code: "GROK_HTTP_ERROR",
          httpStatus: response.status,
          retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      } satisfies ApiFailureResponse;
    }
    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (text.trimStart().startsWith("<") || contentType.includes("text/html")) {
      return failure(
        request.requestId,
        "Grok returned a web page instead of API data. Refresh the signed-in Grok tab and retry; if it persists, the web endpoint has changed.",
        "GROK_NON_JSON_RESPONSE",
      );
    }
    let body: unknown;
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      return failure(request.requestId, "Grok returned malformed API data.", "INVALID_JSON_RESPONSE");
    }
    if (!isJsonValue(body)) return failure(request.requestId, "Grok returned an unsupported JSON value.", "INVALID_JSON_RESPONSE");
    return {
      requestId: request.requestId,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: true,
      status: response.status,
      body: body as JsonValue,
      responseBytes,
    } satisfies ApiSuccessResponse;
  } catch (error) {
    const sanitized = sanitizeError(error);
    const timeoutError = error instanceof DOMException && error.name === "AbortError";
    return {
      requestId: request.requestId,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: {
        ...sanitized,
        retryable: timeoutError,
        ...(timeoutError ? { code: "REQUEST_TIMEOUT" } : sanitized.code === undefined ? {} : { code: sanitized.code }),
      },
    } satisfies ApiFailureResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}

function failure(requestId: string, message: string, code: string): ApiFailureResponse {
  return {
    requestId,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ok: false,
    error: { name: "GrokBridgeError", message, code, retryable: false },
  };
}
