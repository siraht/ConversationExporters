import type { JsonValue } from "../core/types";
import { parseOperationRequest, type ChatGptOperationParameters } from "../chatgpt/endpoints";
import type { ChatGptTransport } from "../chatgpt/client";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const PAGE_REQUEST_CHANNEL = "chatgpt-exporter:page-request:v1";
export const PAGE_RESPONSE_CHANNEL = "chatgpt-exporter:page-response:v1";

export interface FindTabResult {
  ok: boolean;
  tabId?: number;
  title?: string;
  error?: string;
}

export type ApiRequest = ChatGptOperationParameters & {
  requestId: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  workspaceId: string | null;
  timeoutMs: number;
};

export interface ApiSuccessResponse {
  requestId: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  ok: true;
  status: number;
  body: JsonValue;
  responseBytes: number;
  correlationId: string;
}

export interface ApiFailureResponse {
  requestId: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  ok: false;
  status?: number;
  error: {
    name: string;
    message: string;
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
    correlationId: string;
    responseBytes?: number;
  };
}

export type ApiResponse = ApiSuccessResponse | ApiFailureResponse;

export class RuntimeApiTransport implements ChatGptTransport {
  constructor(private readonly tabId: number) {}

  async request(operation: ChatGptOperationParameters, workspaceId: string | null, timeoutMs = 30_000): Promise<ApiSuccessResponse> {
    const message = {
      type: "CHATGPT_EXPORTER_API_REQUEST",
      tabId: this.tabId,
      request: {
        ...operation,
        requestId: crypto.randomUUID(),
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workspaceId,
        timeoutMs,
      },
    };
    const response = await chrome.runtime.sendMessage<typeof message, ApiResponse>(message);
    if (!response.ok) throw new BridgeResponseError(response);
    return response;
  }
}

export class BridgeResponseError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly correlationId: string;

  constructor(response: ApiFailureResponse) {
    super(response.error.message);
    this.name = "BridgeResponseError";
    this.code = response.error.code;
    this.status = response.status;
    this.retryable = response.error.retryable;
    this.retryAfterMs = response.error.retryAfterMs;
    this.correlationId = response.error.correlationId;
  }
}

export function parseApiRequest(value: unknown): ApiRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["requestId", "protocolVersion", "workspaceId", "timeoutMs", "operation", "parameters"]);
  const unexpectedKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length) invalid(`request contains unexpected fields: ${unexpectedKeys.join(", ")}`);
  const requestId = typeof input.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)
    ? input.requestId
    : invalid("requestId is invalid");
  if (input.protocolVersion !== BRIDGE_PROTOCOL_VERSION) invalid("protocolVersion is invalid");
  if (!Number.isInteger(input.timeoutMs) || (input.timeoutMs as number) < 1_000 || (input.timeoutMs as number) > 120_000) {
    invalid("timeoutMs must be between 1000 and 120000");
  }
  if (input.workspaceId !== null && (typeof input.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(input.workspaceId))) {
    invalid("workspaceId is invalid");
  }
  const operation = parseOperationRequest({ operation: input.operation, parameters: input.parameters });
  return {
    ...operation,
    requestId,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    workspaceId: input.workspaceId as string | null,
    timeoutMs: input.timeoutMs as number,
  } as ApiRequest;
}

export function isApiResponse(value: unknown): value is ApiResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Partial<ApiResponse>;
  return response.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && typeof response.requestId === "string"
    && typeof response.ok === "boolean";
}

export function failureResponse(
  requestId: string,
  code: string,
  message: string,
  options: { status?: number; retryable?: boolean; retryAfterMs?: number; responseBytes?: number; correlationId?: string } = {},
): ApiFailureResponse {
  const correlationId = options.correlationId ?? crypto.randomUUID();
  return {
    requestId,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ok: false,
    ...(options.status === undefined ? {} : { status: options.status }),
    error: {
      name: "ChatGPTExporterError",
      message,
      code,
      retryable: options.retryable ?? false,
      correlationId,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      ...(options.responseBytes === undefined ? {} : { responseBytes: options.responseBytes }),
    },
  };
}

export function requestId(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const candidate = (value as { requestId?: unknown }).requestId;
  return typeof candidate === "string" && candidate ? candidate : "unknown";
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function invalid(message: string): never {
  throw new Error(message);
}
