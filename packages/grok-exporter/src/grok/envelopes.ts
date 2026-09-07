import { asJsonObject, firstArray, firstBoolean, firstString, isJsonObject } from "../core/json";
import type { ConversationListEntry, JsonObject, JsonValue, ValidationFinding } from "../core/types";
import { hashJson } from "../core/hash";

const LIST_PATHS = [
  ["conversations"],
  ["result", "conversations"],
  ["data", "conversations"],
  ["items"],
] as const;

const NODE_PATHS = [
  ["responseNodes"],
  ["response_nodes"],
  ["nodes"],
  ["items"],
  ["result", "responseNodes"],
  ["data", "responseNodes"],
  ["result", "items"],
  ["data", "items"],
] as const;

const RESPONSE_PATHS = [
  ["responses"],
  ["items"],
  ["result", "responses"],
  ["data", "responses"],
  ["result", "items"],
  ["data", "items"],
] as const;

export function conversationListFromEnvelope(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  return requiredCollection(value, LIST_PATHS, "conversations");
}

export function responseNodesFromEnvelope(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  return requiredCollection(value, NODE_PATHS, "response nodes");
}

export function responsesFromEnvelope(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  return requiredCollection(value, RESPONSE_PATHS, "responses");
}

export function assetsFromEnvelope(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  return requiredCollection(value, [["assets"], ["result", "assets"], ["data", "assets"], ["items"], ["data"], ["result"]], "assets");
}

export function workspacesFromEnvelope(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  return requiredCollection(value, [["workspaces"], ["result", "workspaces"], ["data", "workspaces"], ["items"], ["data"], ["result"]], "workspaces");
}

function requiredCollection(value: JsonValue, paths: readonly (readonly string[])[], label: string): JsonValue[] {
  for (const path of paths) {
    let candidate: JsonValue | undefined = value;
    for (const key of path) candidate = isJsonObject(candidate) ? candidate[key] : undefined;
    if (Array.isArray(candidate)) return candidate;
  }
  throw new Error(`Unrecognized Grok ${label} inventory envelope; refusing to treat it as an empty collection.`);
}

export function nextPageTokenFromEnvelope(value: JsonValue): string | undefined {
  return firstString(value, [
    ["nextPageToken"],
    ["next_page_token"],
    ["result", "nextPageToken"],
    ["data", "nextPageToken"],
    ["pagination", "nextPageToken"],
  ]);
}

export function nextResponseCursorFromEnvelope(value: JsonValue): string | undefined {
  return firstString(value, [
    ["nextCursor"],
    ["cursor"],
    ["nextPageToken"],
    ["next"],
    ["result", "nextCursor"],
    ["data", "nextCursor"],
  ]);
}

export function responseEnvelopeHasMore(value: JsonValue): boolean {
  return firstBoolean(value, [
    ["hasMore"],
    ["hasNextPage"],
    ["result", "hasMore"],
    ["data", "hasMore"],
  ]) ?? false;
}

export async function normalizeListEntry(value: JsonValue): Promise<ConversationListEntry | undefined> {
  if (!isJsonObject(value)) return undefined;
  const id = firstString(value, [
    ["conversationId"], ["conversation_id"], ["id"], ["uuid"],
  ]);
  if (!id) return undefined;

  const workspaceValues = firstArray(value, [["workspaces"]]);
  const workspaceIds = workspaceValues
    .map((workspace) => firstString(workspace, [["workspaceId"], ["workspace_id"], ["id"], ["uuid"]]))
    .filter((candidate): candidate is string => Boolean(candidate));

  return {
    id,
    title: firstString(value, [["title"], ["name"], ["displayTitle"], ["display_title"]]) ?? "Untitled Conversation",
    workspaceIds: [...new Set(workspaceIds)],
    listingHash: await hashJson(value),
    raw: value,
    ...optionalString("createdAt", firstString(value, [["createTime"], ["create_time"], ["createdAt"], ["created_at"]])),
    ...optionalString("updatedAt", firstString(value, [["modifyTime"], ["updateTime"], ["updatedAt"], ["updated_at"]])),
    ...optionalBoolean("starred", firstBoolean(value, [["starred"]])),
    ...optionalBoolean("temporary", firstBoolean(value, [["temporary"]])),
  };
}

export function responseIdFromValue(value: JsonValue): string | undefined {
  return firstString(value, [
    ["responseId"],
    ["response_id"],
    ["id"],
    ["messageId"],
    ["message_id"],
    ["response", "responseId"],
    ["response", "id"],
    ["message", "id"],
  ]);
}

export function collectResponseIds(values: JsonValue[]): { ids: string[]; findings: ValidationFinding[] } {
  const ids: string[] = [];
  const findings: ValidationFinding[] = [];
  const seen = new Set<string>();

  values.forEach((value, index) => {
    const id = responseIdFromValue(value);
    if (!id) {
      findings.push({
        code: "RESPONSE_ID_MISSING",
        severity: "error",
        message: `Response item ${index} has no recognized identifier.`,
        details: { index },
      });
      return;
    }
    if (seen.has(id)) {
      findings.push({
        code: "RESPONSE_ID_DUPLICATE",
        severity: "error",
        message: `Response identifier ${id} appears more than once.`,
        responseId: id,
      });
      return;
    }
    seen.add(id);
    ids.push(id);
  });

  return { ids, findings };
}

export function jsonObjectOrEmpty(value: JsonValue): JsonObject {
  return asJsonObject(value);
}

function optionalString<Key extends string>(key: Key, value: string | undefined): { [P in Key]?: string } {
  return value === undefined ? {} : { [key]: value } as { [P in Key]?: string };
}

function optionalBoolean<Key extends string>(key: Key, value: boolean | undefined): { [P in Key]?: boolean } {
  return value === undefined ? {} : { [key]: value } as { [P in Key]?: boolean };
}
