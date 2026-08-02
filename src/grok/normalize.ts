import { hashJson } from "../core/hash";
import { asJsonObject, firstArray, firstBoolean, firstString, isJsonObject, readPath } from "../core/json";
import type {
  JsonObject,
  JsonValue,
  MessageRole,
  NormalizedAttachment,
  NormalizedCitation,
  NormalizedConversation,
  NormalizedMessage,
  RawConversationCapture,
  ValidationFinding,
} from "../core/types";
import { NORMALIZED_SCHEMA_VERSION } from "../core/types";
import { capturedResponses } from "./client";
import { normalizeListEntry, responseIdFromValue, responseNodesFromEnvelope } from "./envelopes";

export interface NormalizeResult {
  conversation: NormalizedConversation;
  findings: ValidationFinding[];
}

export async function normalizeConversation(capture: RawConversationCapture): Promise<NormalizeResult> {
  const listing = await normalizeListEntry(capture.listingEntry);
  if (!listing) throw new Error("Raw capture has no conversation ID.");

  const metadata = capture.metadata;
  const nodes = responseNodesFromEnvelope(capture.responseNodes);
  const responses = capturedResponses(capture);
  const findings: ValidationFinding[] = [];
  const nodeById = new Map<string, JsonValue>();
  const responseById = new Map<string, JsonValue>();
  const responseOrder: string[] = [];

  for (const node of nodes) {
    const id = responseIdFromValue(node);
    if (id && !nodeById.has(id)) nodeById.set(id, node);
  }
  for (const response of responses) {
    const id = responseIdFromValue(response);
    if (!id) continue;
    if (responseById.has(id)) {
      findings.push({
        code: "CAPTURED_RESPONSE_DUPLICATE",
        severity: "error",
        message: `Captured response ${id} more than once.`,
        conversationId: listing.id,
        responseId: id,
      });
      continue;
    }
    responseById.set(id, response);
    responseOrder.push(id);
  }

  const orderedIds = [
    ...nodeById.keys(),
    ...responseOrder.filter((id) => !nodeById.has(id)),
  ];
  const messages: NormalizedMessage[] = [];

  for (const id of orderedIds) {
    const response = responseById.get(id);
    const node = nodeById.get(id);
    if (!response && node) continue;
    if (!response) continue;
    const message = normalizeMessage(id, response, node, listing.id);
    messages.push(message);
    findings.push(...message.warnings);
  }

  deriveChildRelationships(messages, findings, listing.id);
  const rootMessageIds = messages.filter((message) => !message.parentId).map((message) => message.id);
  const metadataWorkspaces = extractWorkspaceIds(metadata);
  const captureJson = JSON.parse(JSON.stringify(capture)) as JsonValue;
  const rawCaptureHash = await hashJson(captureJson);

  const title = firstString(metadata, [["title"], ["name"], ["conversationName"]]) ?? listing.title;
  const createdAt = firstString(metadata, [["createTime"], ["createdAt"], ["created_at"]]) ?? listing.createdAt;
  const updatedAt = firstString(metadata, [["modifyTime"], ["updateTime"], ["updatedAt"], ["updated_at"]]) ?? listing.updatedAt;
  const starred = firstBoolean(metadata, [["starred"]]) ?? listing.starred;
  const temporary = firstBoolean(metadata, [["temporary"]]) ?? listing.temporary;

  const conversation: NormalizedConversation = {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    provider: "grok",
    id: listing.id,
    title,
    sourceUrl: `https://grok.com/c/${encodeURIComponent(listing.id)}`,
    capturedAt: capture.capturedAt,
    workspaceIds: [...new Set([
      ...listing.workspaceIds,
      ...metadataWorkspaces,
      ...(capture.discoveredWorkspaceIds ?? []),
    ])],
    rootMessageIds,
    messages,
    extensions: { grokMetadata: metadata },
    provenance: {
      rawCaptureHash,
      sourcePaths: [
        "source/listing-entry.json",
        "source/conversation.json",
        "source/response-nodes.json",
        ...capture.responseBatches.map((batch) => `source/responses-${String(batch.batchNumber).padStart(4, "0")}.json`),
      ],
    },
    warnings: findings,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(starred === undefined ? {} : { starred }),
    ...(temporary === undefined ? {} : { temporary }),
  };

  return { conversation, findings };
}

function normalizeMessage(id: string, response: JsonValue, node: JsonValue | undefined, conversationId: string): NormalizedMessage {
  const warnings: ValidationFinding[] = [];
  const sender = firstString(response, [
    ["sender"], ["role"], ["author", "role"], ["author"], ["message", "sender"], ["message", "role"],
  ]);
  const role = normalizeRole(sender);
  if (role === "unknown") {
    warnings.push({
      code: "MESSAGE_ROLE_UNKNOWN",
      severity: "warning",
      message: `Response ${id} has no recognized sender role.`,
      conversationId,
      responseId: id,
      ...(sender === undefined ? {} : { details: { sender } }),
    });
  }

  const text = extractText(response);
  const attachments = extractAttachments(response);
  if (!text && attachments.length === 0) {
    warnings.push({
      code: "MESSAGE_CONTENT_EMPTY",
      severity: "warning",
      message: `Response ${id} has neither recognized text nor attachments.`,
      conversationId,
      responseId: id,
    });
  }

  const parentId = firstString(response, [
    ["parentResponseId"], ["parent_response_id"], ["parentId"], ["parent_id"],
  ]) ?? (node === undefined ? undefined : firstString(node, [
    ["parentResponseId"], ["parent_response_id"], ["parentId"], ["parent_id"],
  ]));

  const childIds = node === undefined ? [] : extractChildIds(node);
  const responseObject = asJsonObject(response);
  return {
    id,
    role,
    text,
    markdown: text,
    childIds,
    citations: extractCitations(response),
    attachments,
    rawResponseId: id,
    extensions: { grok: responseObject },
    warnings,
    ...(sender === undefined ? {} : { senderLabel: sender }),
    ...optionalString("createdAt", firstString(response, [["createTime"], ["createdAt"], ["created_at"], ["timestamp"]])),
    ...optionalString("model", firstString(response, [["model"], ["modelName"], ["metadata", "model"]])),
    ...optionalString("parentId", parentId),
    ...optionalBoolean("selected", firstBoolean(node, [["selected"], ["isSelected"], ["active"]])),
  };
}

export function normalizeRole(sender: string | undefined): MessageRole {
  if (!sender) return "unknown";
  const normalized = sender.toLowerCase().trim();
  if (["human", "user"].includes(normalized)) return "user";
  if (["assistant", "grok", "model", "bot", "ai"].includes(normalized)) return "assistant";
  if (normalized === "system") return "system";
  if (["tool", "function", "search"].includes(normalized)) return "tool";
  return "unknown";
}

export function extractText(value: JsonValue): string {
  const direct = firstString(value, [
    ["message"], ["query"], ["content"], ["text"], ["markdown"], ["body"], ["output"],
    ["message", "content"], ["message", "text"], ["response", "message"], ["response", "text"],
  ]);
  if (direct !== undefined) return direct.trim();

  for (const path of [["parts"], ["chunks"], ["segments"], ["message", "parts"], ["content", "parts"]] as const) {
    const candidate = readPath(value, path);
    const text = stringifyParts(candidate);
    if (text) return text;
  }
  return "";
}

function stringifyParts(value: JsonValue | undefined, depth = 0): string {
  if (value === undefined || value === null || depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => stringifyParts(item, depth + 1)).filter(Boolean).join("\n").trim();
  if (!isJsonObject(value)) return "";
  for (const key of ["text", "content", "markdown", "message", "value", "parts", "chunks", "segments"]) {
    const text = stringifyParts(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function extractCitations(value: JsonValue): NormalizedCitation[] {
  const candidates = [
    ...firstArray(value, [["citations"]]),
    ...firstArray(value, [["sources"]]),
    ...firstArray(value, [["citedWebSearchResults"]]),
    ...firstArray(value, [["webResults"]]),
    ...firstArray(value, [["web_results"]]),
    ...firstArray(value, [["searchResults"]]),
    ...firstArray(value, [["webpageUrls"]]),
    ...firstArray(value, [["metadata", "citations"]]),
  ];
  const xpostIds = new Set(firstArray(value, [["xpostIds"]])
    .map((id) => typeof id === "string" || typeof id === "number" ? String(id) : undefined)
    .filter((id): id is string => Boolean(id)));
  const xpostCandidates = [
    ...firstArray(value, [["citedXposts"]]),
    ...firstArray(value, [["xposts"]]).filter((candidate) => {
      if (xpostIds.size === 0) return false;
      const postId = typeof candidate === "string" || typeof candidate === "number"
        ? String(candidate)
        : firstString(candidate, [["postId"], ["id"]]);
      return postId !== undefined && xpostIds.has(postId);
    }),
  ];
  const citations: NormalizedCitation[] = [];
  const seen = new Set<string>();
  for (const candidate of [...candidates, ...xpostCandidates]) {
    const url = typeof candidate === "string"
      ? (/^https?:\/\//i.test(candidate) ? candidate : xPostUrl(candidate))
      : firstString(candidate, [["url"], ["link"], ["uri"], ["sourceUrl"]]) ?? xPostUrl(candidate);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const object = asJsonObject(candidate);
    const title = firstString(candidate, [["title"], ["name"], ["label"]]);
    const startIndex = numericValue(candidate, [["startIndex"], ["start"], ["offset"]]);
    const endIndex = numericValue(candidate, [["endIndex"], ["end"]]);
    citations.push({
      url,
      raw: object,
      ...(title === undefined ? {} : { title }),
      ...(startIndex === undefined ? {} : { startIndex }),
      ...(endIndex === undefined ? {} : { endIndex }),
    });
  }
  return citations;
}

function xPostUrl(value: JsonValue): string | undefined {
  const postId = typeof value === "string" || typeof value === "number"
    ? String(value)
    : firstString(value, [["postId"], ["id"]]);
  if (!postId || !/^\d+$/.test(postId)) return undefined;
  const username = typeof value === "string" || typeof value === "number"
    ? undefined
    : firstString(value, [["username"]]);
  const safeUsername = username?.match(/^[A-Za-z0-9_]{1,15}$/)?.[0] ?? "i";
  return `https://x.com/${safeUsername}/status/${postId}`;
}

function extractAttachments(value: JsonValue): NormalizedAttachment[] {
  const attachments: NormalizedAttachment[] = [];
  const seen = new Set<string>();
  const arrays: Array<{ path: readonly string[]; defaultKind: NormalizedAttachment["kind"] }> = [
    { path: ["generatedImageUrls"], defaultKind: "image" },
    { path: ["imageAttachments"], defaultKind: "image" },
    { path: ["fileAttachments"], defaultKind: "document" },
    { path: ["attachments"], defaultKind: "unknown" },
    { path: ["media"], defaultKind: "unknown" },
    { path: ["metadata", "attachments"], defaultKind: "unknown" },
  ];

  for (const { path, defaultKind } of arrays) {
    const values = firstArray(value, [path]);
    for (const item of values) {
      const sourceUrl = typeof item === "string" ? item : firstString(item, [["url"], ["downloadUrl"], ["sourceUrl"], ["src"]]);
      const id = typeof item === "string" ? undefined : firstString(item, [["id"], ["assetId"], ["fileId"], ["uuid"]]);
      const mediaType = typeof item === "string" ? undefined : firstString(item, [["mimeType"], ["mediaType"], ["contentType"], ["type"]]);
      const name = typeof item === "string" ? undefined : firstString(item, [["name"], ["fileName"], ["title"]]);
      const key = id ?? sourceUrl ?? `${path.join(".")}:${attachments.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = asJsonObject(item);
      attachments.push({
        kind: attachmentKind(mediaType, defaultKind),
        raw,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
        ...optionalNumber("size", typeof item === "string" ? undefined : numericValue(item, [["size"], ["fileSize"]])),
      });
    }
  }
  return attachments;
}

function attachmentKind(mediaType: string | undefined, fallback: NormalizedAttachment["kind"]): NormalizedAttachment["kind"] {
  const normalized = mediaType?.toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  if (/code|javascript|typescript|python|shell/.test(normalized)) return "code";
  if (normalized) return "document";
  return fallback;
}

function extractChildIds(value: JsonValue): string[] {
  const childValues = firstArray(value, [["children"], ["childResponseIds"], ["child_response_ids"], ["childIds"]]);
  return [...new Set(childValues.map((child) => typeof child === "string" ? child : responseIdFromValue(child)).filter((id): id is string => Boolean(id)))];
}

function extractWorkspaceIds(value: JsonValue): string[] {
  const ids = firstArray(value, [["workspaces"]])
    .map((workspace) => typeof workspace === "string" ? workspace : firstString(workspace, [["workspaceId"], ["id"], ["uuid"]]))
    .filter((id): id is string => Boolean(id));
  const direct = firstString(value, [["workspaceId"], ["workspace", "id"]]);
  if (direct) ids.push(direct);
  return [...new Set(ids)];
}

function deriveChildRelationships(messages: NormalizedMessage[], findings: ValidationFinding[], conversationId: string): void {
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages) {
    if (!message.parentId) continue;
    const parent = byId.get(message.parentId);
    if (!parent) {
      findings.push({
        code: "PARENT_RESPONSE_MISSING",
        severity: "warning",
        message: `Response ${message.id} references missing parent ${message.parentId}.`,
        conversationId,
        responseId: message.id,
      });
      continue;
    }
    if (!parent.childIds.includes(message.id)) parent.childIds.push(message.id);
  }
  for (const message of messages) message.childIds = [...new Set(message.childIds)];
}

function numericValue(value: JsonValue, paths: readonly (readonly string[])[]): number | undefined {
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim() && Number.isFinite(Number(candidate))) return Number(candidate);
  }
  return undefined;
}

function optionalString<Key extends string>(key: Key, value: string | undefined): { [P in Key]?: string } {
  return value === undefined ? {} : { [key]: value } as { [P in Key]?: string };
}

function optionalBoolean<Key extends string>(key: Key, value: boolean | undefined): { [P in Key]?: boolean } {
  return value === undefined ? {} : { [key]: value } as { [P in Key]?: boolean };
}

function optionalNumber<Key extends string>(key: Key, value: number | undefined): { [P in Key]?: number } {
  return value === undefined ? {} : { [key]: value } as { [P in Key]?: number };
}
