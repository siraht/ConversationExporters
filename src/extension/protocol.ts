import { GrokExporterError } from "../core/errors";
import { BRIDGE_PROTOCOL_VERSION, type ApiRequest, type ApiResponse, type ApiSuccessResponse, type ApiTransport, type JsonValue } from "../core/types";

export const PAGE_REQUEST_CHANNEL = "grok-exporter:page-request:v1";
export const PAGE_RESPONSE_CHANNEL = "grok-exporter:page-response:v1";

export interface RuntimeFindTabRequest {
  type: "GROK_EXPORTER_FIND_TAB";
}

export interface RuntimeApiRequest {
  type: "GROK_EXPORTER_API_REQUEST";
  tabId: number;
  request: ApiRequest;
}

export type DashboardRuntimeRequest = RuntimeFindTabRequest | RuntimeApiRequest;

export interface FindTabResult {
  ok: boolean;
  tabId?: number;
  title?: string;
  error?: string;
}

export class RuntimeApiTransport implements ApiTransport {
  constructor(private readonly tabId: number) {}

  async request(request: Omit<ApiRequest, "requestId" | "protocolVersion">): Promise<ApiSuccessResponse> {
    const message: RuntimeApiRequest = {
      type: "GROK_EXPORTER_API_REQUEST",
      tabId: this.tabId,
      request: {
        ...request,
        requestId: crypto.randomUUID(),
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      },
    };
    const response = await chrome.runtime.sendMessage<DashboardRuntimeRequest, ApiResponse>(message);
    if (!response.ok) {
      throw new GrokExporterError(response.error.message, {
        ...(response.error.code === undefined ? {} : { code: response.error.code }),
        ...(response.error.httpStatus === undefined ? {} : { httpStatus: response.error.httpStatus }),
        retryable: response.error.retryable,
        ...(response.error.retryAfterMs === undefined ? {} : { retryAfterMs: response.error.retryAfterMs }),
      });
    }
    return response;
  }
}

export function isApiRequest(value: unknown): value is ApiRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ApiRequest>;
  return request.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && typeof request.requestId === "string"
    && typeof request.path === "string"
    && (request.method === "GET" || request.method === "POST")
    && typeof request.timeoutMs === "number"
    && request.timeoutMs > 0
    && request.timeoutMs <= 120_000;
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

