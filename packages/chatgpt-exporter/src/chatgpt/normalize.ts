import { graphFindings } from "./capture";
import type { ChatGptConversationDetail, ChatGptMessage, ChatGptMessageContent } from "./envelopes";
import { toJsonValue } from "../core/serialization";
import type {
  InventoryConversation,
  JsonObject,
  JsonValue,
  NormalizedContentPart,
  NormalizedConversation,
  NormalizedMessage,
  NormalizedRole,
  ValidationFinding,
} from "../core/types";

export const NORMALIZER_VERSION = "chatgpt-web-v1";

export function normalizeConversation(
  raw: ChatGptConversationDetail,
  inventory: InventoryConversation,
  workspaceFingerprint: string,
): NormalizedConversation {
  const findings: ValidationFinding[] = graphFindings(raw).map((code) => ({
    severity: "error",
    code: `GRAPH_${code.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    message: `Provider graph finding: ${code}.`,
  }));
  const selectedNodes = selectedPath(raw);
  const nodes = Object.values(raw.mapping).map((node) => ({
    id: node.id,
    messageId: node.message?.id ?? null,
    parentId: node.parent,
    childIds: [...node.children],
    raw: toJsonValue(node),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const messages: NormalizedMessage[] = [];
  for (const node of Object.values(raw.mapping).sort((left, right) => left.id.localeCompare(right.id))) {
    if (!node.message) continue;
    const message = node.message;
    const role = normalizeRole(message.author.role);
    if (role === "unknown") findings.push({
      severity: "warning",
      code: "UNKNOWN_ROLE",
      message: `Unknown provider role ${message.author.role}.`,
      nodeId: node.id,
      messageId: message.id,
    });
    const parts = normalizeParts(message, node.id, findings);
    messages.push({
      id: message.id,
      nodeId: node.id,
      role,
      authorName: optionalString(message.author.name),
      parentId: node.parent,
      childIds: [...node.children],
      createTime: optionalNumber(message.create_time),
      updateTime: optionalNumber(message.update_time),
      recipient: optionalString(message.recipient),
      modelSlug: modelSlug(message),
      status: optionalString(message.status),
      endTurn: typeof message.end_turn === "boolean" || message.end_turn === null ? message.end_turn : null,
      selected: selectedNodes.has(node.id),
      parts,
      metadata: toJsonValue(message.metadata ?? {}),
      extensions: { chatgpt: toJsonValue(message) },
    });
  }
  return {
    schemaVersion: 1,
    normalizerVersion: NORMALIZER_VERSION,
    provider: "chatgpt-web",
    logicalKey: inventory.logicalKey,
    conversationId: inventory.conversationId,
    workspaceFingerprint,
    title: raw.title ?? inventory.title,
    createTime: optionalNumber(raw.create_time) ?? inventory.createTime,
    updateTime: optionalNumber(raw.update_time) ?? inventory.updateTime,
    currentNodeId: raw.current_node,
    rootNodeIds: nodes.filter((node) => node.parentId === null).map((node) => node.id),
    memberships: inventory.memberships.map((membership) => ({ ...membership })),
    nodes,
    messages,
    findings,
    extensions: { chatgpt: toJsonValue(conversationExtensions(raw)) },
  };
}

function normalizeParts(message: ChatGptMessage, nodeId: string, findings: ValidationFinding[]): NormalizedContentPart[] {
  const content = message.content;
  const type = content.content_type;
  const parts: NormalizedContentPart[] = [];
  const rawParts = Array.isArray(content.parts) ? content.parts : [];
  if (type === "text" || type === "multimodal_text") {
    for (const rawPart of rawParts) parts.push(normalizePart(rawPart, nodeId, message.id, findings));
  } else if (type === "code") {
    const language = optionalString(content.language);
    parts.push({ kind: "code", text: contentText(content), ...(language === null ? {} : { language }), raw: toJsonValue(content) });
  } else if (type === "execution_output") {
    parts.push({ kind: "execution_output", text: contentText(content), raw: toJsonValue(content) });
  } else if (["tether_browsing_display", "browsing_result", "tool_result"].includes(type)) {
    parts.push({ kind: "tool_result", text: contentText(content), raw: toJsonValue(content) });
  } else if (["thoughts", "reasoning_recap", "reasoning_summary"].includes(type)) {
    parts.push({ kind: "reasoning_summary", text: contentText(content), raw: toJsonValue(content) });
  } else if (["canvas", "textdoc", "code_edit"].includes(type)) {
    parts.push({ kind: "canvas", text: contentText(content), raw: toJsonValue(content) });
  } else if (["tool_call", "computer_initialize_state"].includes(type)) {
    parts.push({ kind: "tool_call", text: contentText(content), raw: toJsonValue(content) });
  } else {
    parts.push({ kind: "unknown", raw: toJsonValue(content) });
    findings.push({ severity: "warning", code: "UNKNOWN_CONTENT_TYPE", message: `Unknown content type ${type}.`, nodeId, messageId: message.id });
  }
  appendContentReferences(message, parts, nodeId, findings);
  if (message.metadata?.is_async_task_result_message === true || typeof message.metadata?.deep_research_version === "string") {
    parts.push({
      kind: "deep_research",
      title: "Deep research result",
      text: contentText(content),
      raw: toJsonValue(message.metadata),
    });
  }
  if (parts.length === 0) parts.push({ kind: "text", text: "", raw: toJsonValue(content) });
  return parts;
}

function normalizePart(rawPart: unknown, nodeId: string, messageId: string, findings: ValidationFinding[]): NormalizedContentPart {
  if (typeof rawPart === "string") return { kind: "text", text: rawPart, raw: rawPart };
  if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
    findings.push({ severity: "warning", code: "UNKNOWN_CONTENT_PART", message: "A content part had an unsupported primitive shape.", nodeId, messageId });
    return { kind: "unknown", raw: toJsonValue(rawPart) };
  }
  const part = rawPart as Record<string, unknown>;
  const type = optionalString(part.content_type) ?? optionalString(part.type) ?? "unknown";
  if (type === "text") return { kind: "text", text: optionalString(part.text) ?? "", raw: toJsonValue(part) };
  if (["image_asset_pointer", "audio_asset_pointer", "video_asset_pointer", "file", "file_pointer"].includes(type)) {
    const pointer = optionalString(part.asset_pointer) ?? optionalString(part.file_id) ?? optionalString(part.id);
    return { kind: "asset", ...(pointer === null ? {} : { assetId: pointer }), raw: toJsonValue(part) };
  }
  if (type === "code") return { kind: "code", text: optionalString(part.text) ?? optionalString(part.code) ?? "", ...(optionalString(part.language) === null ? {} : { language: optionalString(part.language)! }), raw: toJsonValue(part) };
  if (type.includes("citation") || type === "content_reference") return citationPart(part, nodeId, messageId, findings);
  if (type.includes("tool_call")) return { kind: "tool_call", text: optionalString(part.text) ?? JSON.stringify(part), raw: toJsonValue(part) };
  if (type.includes("tool_result") || type.includes("browsing")) return { kind: "tool_result", text: optionalString(part.text) ?? JSON.stringify(part), raw: toJsonValue(part) };
  findings.push({ severity: "warning", code: "UNKNOWN_CONTENT_PART", message: `Unknown content part type ${type}.`, nodeId, messageId });
  return { kind: "unknown", raw: toJsonValue(part) };
}

function appendContentReferences(message: ChatGptMessage, parts: NormalizedContentPart[], nodeId: string, findings: ValidationFinding[]): void {
  const metadata = message.metadata;
  const candidates = [metadata?.content_references, metadata?.citations, metadata?.sources];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const reference of candidate) {
      if (reference && typeof reference === "object" && !Array.isArray(reference)) parts.push(citationPart(reference as Record<string, unknown>, nodeId, message.id, findings));
    }
  }
}

function citationPart(value: Record<string, unknown>, nodeId: string, messageId: string, findings: ValidationFinding[]): NormalizedContentPart {
  const url = safeHttpUrl(optionalString(value.url) ?? optionalString(value.href));
  const rawUrl = optionalString(value.url) ?? optionalString(value.href);
  if (rawUrl && !url) findings.push({ severity: "warning", code: "UNSAFE_CITATION_URL", message: "A citation used a non-HTTP(S) URL.", nodeId, messageId });
  return {
    kind: "citation",
    ...(optionalString(value.title) === null ? {} : { title: optionalString(value.title)! }),
    ...(url === null ? {} : { url }),
    ...(optionalString(value.text) === null ? {} : { text: optionalString(value.text)! }),
    raw: toJsonValue(value),
  };
}

function selectedPath(raw: ChatGptConversationDetail): Set<string> {
  const selected = new Set<string>();
  let current = raw.current_node;
  while (current && raw.mapping[current] && !selected.has(current)) {
    selected.add(current);
    current = raw.mapping[current]!.parent;
  }
  return selected;
}

function normalizeRole(role: string): NormalizedRole {
  return (["user", "assistant", "system", "tool"] as const).includes(role as "user" | "assistant" | "system" | "tool")
    ? role as NormalizedRole
    : "unknown";
}

function modelSlug(message: ChatGptMessage): string | null {
  const metadata = message.metadata;
  return optionalString(metadata?.model_slug) ?? optionalString(metadata?.model) ?? null;
}

function contentText(content: ChatGptMessageContent): string {
  for (const key of ["text", "code", "result", "output"]) {
    const value = content[key];
    if (typeof value === "string") return value;
  }
  return Array.isArray(content.parts) ? content.parts.filter((part): part is string => typeof part === "string").join("\n") : "";
}

function conversationExtensions(raw: ChatGptConversationDetail): JsonObject {
  const excluded = new Set(["mapping"]);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !excluded.has(key)).map(([key, value]) => [key, toJsonValue(value)]));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
