import type { JsonValue } from "../core/types";

export type ChatGptOperation =
  | "session_probe"
  | "accounts_list"
  | "conversation_page"
  | "project_page"
  | "project_conversation_page"
  | "shared_page"
  | "shared_detail"
  | "conversation_batch"
  | "conversation_detail"
  | "account_artifact"
  | "asset_open"
  | "asset_chunk"
  | "asset_close";

export type ChatGptOperationParameters =
  | { operation: "session_probe"; parameters: Record<string, never> }
  | { operation: "accounts_list"; parameters: Record<string, never> }
  | { operation: "conversation_page"; parameters: { offset: number; limit: number; archived: boolean } }
  | { operation: "project_page"; parameters: { cursor: string | null } }
  | { operation: "project_conversation_page"; parameters: { projectId: string; cursor: string } }
  | { operation: "shared_page"; parameters: { offset: number; limit: number } }
  | { operation: "shared_detail"; parameters: { shareId: string } }
  | { operation: "conversation_batch"; parameters: { conversationIds: string[] } }
  | { operation: "conversation_detail"; parameters: { conversationId: string } }
  | { operation: "account_artifact"; parameters: { kind: "memories" | "custom_instructions" | "settings" | "beta_features" } }
  | { operation: "asset_open"; parameters: { fileId: string; conversationId: string | null; projectId: string | null } }
  | { operation: "asset_chunk"; parameters: { handleId: string; offset: number; length: number } }
  | { operation: "asset_close"; parameters: { handleId: string } };

export interface ResolvedEndpoint {
  operation: ChatGptOperation;
  method: "GET" | "POST";
  path: string;
  body?: JsonValue;
  requiresAuthentication: boolean;
  responseLimitBytes: number;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;
const CURSOR = /^[A-Za-z0-9._~-]{1,512}$/;
const MAX_PAGE_SIZE = 100;
const MAX_BATCH_SIZE = 10;

export function resolveEndpoint(request: ChatGptOperationParameters): ResolvedEndpoint {
  switch (request.operation) {
    case "session_probe":
      return endpoint("GET", "/api/auth/session", false, 1_000_000, request.operation);
    case "accounts_list":
      return endpoint("GET", "/backend-api/accounts/check/v4-2023-04-27", true, 5_000_000, request.operation);
    case "conversation_page": {
      assertOffset(request.parameters.offset);
      assertLimit(request.parameters.limit);
      const query = new URLSearchParams({
        offset: String(request.parameters.offset),
        limit: String(request.parameters.limit),
        order: "updated",
        ...(request.parameters.archived ? { is_archived: "true" } : {}),
      });
      return endpoint("GET", `/backend-api/conversations?${query}`, true, 20_000_000, request.operation);
    }
    case "project_page": {
      const query = new URLSearchParams({ conversations_per_gizmo: "0" });
      if (request.parameters.cursor !== null) query.set("cursor", assertCursor(request.parameters.cursor));
      return endpoint("GET", `/backend-api/gizmos/snorlax/sidebar?${query}`, true, 20_000_000, request.operation);
    }
    case "project_conversation_page": {
      const projectId = assertIdentifier(request.parameters.projectId, "projectId");
      const query = new URLSearchParams({ cursor: assertCursor(request.parameters.cursor) });
      return endpoint("GET", `/backend-api/gizmos/${projectId}/conversations?${query}`, true, 20_000_000, request.operation);
    }
    case "shared_page": {
      assertOffset(request.parameters.offset);
      assertLimit(request.parameters.limit);
      const query = new URLSearchParams({
        order: "updated",
        limit: String(request.parameters.limit),
        offset: String(request.parameters.offset),
      });
      return endpoint("GET", `/backend-api/shared_conversations?${query}`, true, 20_000_000, request.operation);
    }
    case "shared_detail": {
      const shareId = assertIdentifier(request.parameters.shareId, "shareId");
      return endpoint("GET", `/backend-api/share/${shareId}`, true, 100_000_000, request.operation);
    }
    case "conversation_batch": {
      const ids = request.parameters.conversationIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_SIZE) {
        throw new EndpointValidationError(`conversationIds must contain 1-${MAX_BATCH_SIZE} identifiers`);
      }
      if (new Set(ids).size !== ids.length) throw new EndpointValidationError("conversationIds must be unique");
      ids.forEach((id) => assertIdentifier(id, "conversationId"));
      return endpoint("POST", "/backend-api/conversations/batch", true, 100_000_000, request.operation, {
        conversation_ids: ids,
      });
    }
    case "conversation_detail": {
      const conversationId = assertIdentifier(request.parameters.conversationId, "conversationId");
      return endpoint("GET", `/backend-api/conversation/${conversationId}`, true, 100_000_000, request.operation);
    }
    case "account_artifact": {
      const paths = {
        memories: "/backend-api/memories?include_memory_entries=true",
        custom_instructions: "/backend-api/user_system_messages",
        settings: "/backend-api/settings",
        beta_features: "/backend-api/settings/beta_features",
      } as const;
      return endpoint("GET", paths[request.parameters.kind], true, 20_000_000, request.operation);
    }
    case "asset_open": {
      const fileId = assertIdentifier(request.parameters.fileId, "fileId");
      const conversationId = request.parameters.conversationId === null
        ? null
        : assertIdentifier(request.parameters.conversationId, "conversationId");
      const projectId = request.parameters.projectId === null
        ? null
        : assertIdentifier(request.parameters.projectId, "projectId");
      if ((conversationId === null) === (projectId === null)) {
        throw new EndpointValidationError("exactly one conversationId or projectId is required");
      }
      const query = conversationId === null
        ? new URLSearchParams({ gizmo_id: projectId! })
        : new URLSearchParams({ conversation_id: conversationId, inline: "false" });
      return endpoint("GET", `/backend-api/files/download/${fileId}?${query}`, true, 5_000_000, request.operation);
    }
    case "asset_chunk":
    case "asset_close":
      throw new EndpointValidationError(`${request.operation} is a page-local control operation`);
  }
}

export function parseOperationRequest(value: unknown): ChatGptOperationParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EndpointValidationError("request must be an object");
  const request = value as { operation?: unknown; parameters?: unknown };
  if (typeof request.operation !== "string") throw new EndpointValidationError("operation must be a string");
  const parameters = requireParameterObject(request.parameters);
  switch (request.operation) {
    case "session_probe":
    case "accounts_list":
      assertOnlyKeys(parameters, []);
      return { operation: request.operation, parameters: {} };
    case "conversation_page":
      assertOnlyKeys(parameters, ["offset", "limit", "archived"]);
      return {
        operation: request.operation,
        parameters: {
          offset: requireNumber(parameters.offset, "offset"),
          limit: requireNumber(parameters.limit, "limit"),
          archived: requireBoolean(parameters.archived, "archived"),
        },
      };
    case "project_page":
      assertOnlyKeys(parameters, ["cursor"]);
      return { operation: request.operation, parameters: { cursor: requireNullableString(parameters.cursor, "cursor") } };
    case "project_conversation_page":
      assertOnlyKeys(parameters, ["projectId", "cursor"]);
      return {
        operation: request.operation,
        parameters: {
          projectId: requireString(parameters.projectId, "projectId"),
          cursor: requireString(parameters.cursor, "cursor"),
        },
      };
    case "shared_page":
      assertOnlyKeys(parameters, ["offset", "limit"]);
      return {
        operation: request.operation,
        parameters: {
          offset: requireNumber(parameters.offset, "offset"),
          limit: requireNumber(parameters.limit, "limit"),
        },
      };
    case "shared_detail":
      assertOnlyKeys(parameters, ["shareId"]);
      return { operation: request.operation, parameters: { shareId: requireString(parameters.shareId, "shareId") } };
    case "conversation_batch":
      assertOnlyKeys(parameters, ["conversationIds"]);
      if (!Array.isArray(parameters.conversationIds) || !parameters.conversationIds.every((id) => typeof id === "string")) {
        throw new EndpointValidationError("conversationIds must be an array of strings");
      }
      return { operation: request.operation, parameters: { conversationIds: [...parameters.conversationIds] } };
    case "conversation_detail":
      assertOnlyKeys(parameters, ["conversationId"]);
      return {
        operation: request.operation,
        parameters: { conversationId: requireString(parameters.conversationId, "conversationId") },
      };
    case "account_artifact":
      assertOnlyKeys(parameters, ["kind"]);
      if (!["memories", "custom_instructions", "settings", "beta_features"].includes(String(parameters.kind))) {
        throw new EndpointValidationError("account artifact kind is invalid");
      }
      return { operation: request.operation, parameters: { kind: parameters.kind as "memories" | "custom_instructions" | "settings" | "beta_features" } };
    case "asset_open":
      assertOnlyKeys(parameters, ["fileId", "conversationId", "projectId"]);
      return {
        operation: request.operation,
        parameters: {
          fileId: requireString(parameters.fileId, "fileId"),
          conversationId: requireNullableString(parameters.conversationId, "conversationId"),
          projectId: requireNullableString(parameters.projectId, "projectId"),
        },
      };
    case "asset_chunk":
      assertOnlyKeys(parameters, ["handleId", "offset", "length"]);
      return {
        operation: request.operation,
        parameters: {
          handleId: requireHandleId(parameters.handleId),
          offset: requireNumber(parameters.offset, "offset"),
          length: requireNumber(parameters.length, "length"),
        },
      };
    case "asset_close":
      assertOnlyKeys(parameters, ["handleId"]);
      return { operation: request.operation, parameters: { handleId: requireHandleId(parameters.handleId) } };
    default:
      throw new EndpointValidationError(`unsupported operation ${request.operation}`);
  }
}

export function validateOperation(request: ChatGptOperationParameters): void {
  if (request.operation === "asset_chunk") {
    requireHandleId(request.parameters.handleId);
    if (!Number.isSafeInteger(request.parameters.offset) || request.parameters.offset < 0) throw new EndpointValidationError("asset offset is invalid");
    if (!Number.isInteger(request.parameters.length) || request.parameters.length < 1 || request.parameters.length > 1_048_576) {
      throw new EndpointValidationError("asset chunk length must be 1-1048576");
    }
    return;
  }
  if (request.operation === "asset_close") {
    requireHandleId(request.parameters.handleId);
    return;
  }
  resolveEndpoint(request);
}

export class EndpointValidationError extends Error {
  readonly code = "INVALID_BRIDGE_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "EndpointValidationError";
  }
}

function endpoint(
  method: "GET" | "POST",
  path: string,
  requiresAuthentication: boolean,
  responseLimitBytes: number,
  operation: ChatGptOperation,
  body?: JsonValue,
): ResolvedEndpoint {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || new URL(path, "https://chatgpt.com").origin !== "https://chatgpt.com") {
    throw new EndpointValidationError("resolved endpoint escaped the ChatGPT origin");
  }
  return { operation, method, path, requiresAuthentication, responseLimitBytes, ...(body === undefined ? {} : { body }) };
}

function assertIdentifier(value: string, name: string): string {
  if (!IDENTIFIER.test(value)) throw new EndpointValidationError(`${name} contains invalid characters`);
  return value;
}

function assertCursor(value: string): string {
  if (!CURSOR.test(value)) throw new EndpointValidationError("cursor contains invalid characters");
  return value;
}

function assertOffset(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new EndpointValidationError("offset is invalid");
}

function assertLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new EndpointValidationError(`limit must be 1-${MAX_PAGE_SIZE}`);
}

function requireParameterObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EndpointValidationError("parameters must be an object");
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, expected: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  if (unexpected.length) throw new EndpointValidationError(`unexpected parameters: ${unexpected.join(", ")}`);
  const missing = expected.filter((key) => !(key in value));
  if (missing.length) throw new EndpointValidationError(`missing parameters: ${missing.join(", ")}`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new EndpointValidationError(`${name} must be a non-empty string`);
  return value;
}

function requireNullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requireString(value, name);
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number") throw new EndpointValidationError(`${name} must be a number`);
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new EndpointValidationError(`${name} must be a boolean`);
  return value;
}

function requireHandleId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new EndpointValidationError("asset handleId is invalid");
  return value;
}
