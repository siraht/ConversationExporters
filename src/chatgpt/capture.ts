import type { InventoryConversation, JsonValue } from "../core/types";
import type { ChatGptTransport, DiscoveredWorkspace } from "./client";
import { EnvelopeError, parseConversationDetail, type ChatGptConversationDetail } from "./envelopes";

export interface RawBatchCapture {
  requestedConversationIds: string[];
  returnedConversationIds: string[];
  missingConversationIds: string[];
  suspiciousConversationIds: string[];
  response: JsonValue;
  responseBytes: number;
  correlationId: string;
}

export interface RetrievedConversationDetail {
  inventory: InventoryConversation;
  detail: ChatGptConversationDetail;
  raw: JsonValue;
  source: "batch" | "single" | "shared";
  fallbackReason?: "batch_missing" | "batch_duplicate" | "batch_invalid" | "batch_graph_suspicious";
  correlationId: string;
  responseBytes: number;
}

type BatchFallbackReason = NonNullable<RetrievedConversationDetail["fallbackReason"]>;

export interface DetailCaptureResult {
  batches: RawBatchCapture[];
  conversations: RetrievedConversationDetail[];
}

export type DetailCaptureCheckpoint = (result: DetailCaptureResult) => Promise<void>;

export class ChatGptDetailFetcher {
  constructor(
    private readonly transport: ChatGptTransport,
    private readonly workspace: DiscoveredWorkspace,
    private readonly batchSize = 10,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new DetailCaptureError("INVALID_BATCH_SIZE", "Batch size must be 1-10.");
  }

  async fetchAll(inventory: InventoryConversation[], checkpoint?: DetailCaptureCheckpoint): Promise<DetailCaptureResult> {
    const output: RetrievedConversationDetail[] = [];
    const batches: RawBatchCapture[] = [];
    const regular = inventory.filter((conversation) => !shareIdFor(conversation));
    const shared = inventory.filter((conversation) => shareIdFor(conversation));

    for (let offset = 0; offset < regular.length; offset += this.batchSize) {
      const group = regular.slice(offset, offset + this.batchSize);
      const result = await this.fetchBatch(group);
      batches.push(result.batch);
      output.push(...result.conversations);
      await checkpoint?.({ batches: [result.batch], conversations: result.conversations });
    }
    for (const conversation of shared) {
      const retrieved = await this.fetchShared(conversation, shareIdFor(conversation)!);
      output.push(retrieved);
      await checkpoint?.({ batches: [], conversations: [retrieved] });
    }

    if (output.length !== inventory.length) {
      throw new DetailCaptureError("DETAIL_COUNT_MISMATCH", `Retrieved ${output.length} details for ${inventory.length} inventory records.`);
    }
    const logicalKeys = new Set(output.map((item) => item.inventory.logicalKey));
    if (logicalKeys.size !== inventory.length) throw new DetailCaptureError("DETAIL_DUPLICATE", "Detail retrieval produced duplicate logical conversations.");
    return { batches, conversations: output };
  }

  private async fetchBatch(group: InventoryConversation[]): Promise<{ batch: RawBatchCapture; conversations: RetrievedConversationDetail[] }> {
    const requestedIds = group.map((conversation) => conversation.conversationId);
    const response = await this.transport.request({
      operation: "conversation_batch",
      parameters: { conversationIds: requestedIds },
    }, this.workspace.accountId, 120_000);
    const candidates = batchCandidates(response.body);
    const candidateById = new Map<string, { raw: JsonValue; parsed?: ChatGptConversationDetail; issue?: BatchFallbackReason }>();
    const duplicateIds = new Set<string>();
    for (const raw of candidates) {
      let id: string | null = null;
      let parsed: ChatGptConversationDetail | undefined;
      let issue: BatchFallbackReason | undefined;
      try {
        parsed = parseConversationDetail(raw);
        id = parsed.id ?? parsed.conversation_id ?? null;
        if (!id || !requestedIds.includes(id)) continue;
        if (!hasOnlySafeCompactNullRoot(raw) || graphFindings(parsed).length) issue = "batch_graph_suspicious";
      } catch (error) {
        if (!(error instanceof EnvelopeError)) throw error;
        id = looseConversationId(raw);
        issue = "batch_invalid";
      }
      if (!id || !requestedIds.includes(id)) continue;
      if (candidateById.has(id)) {
        duplicateIds.add(id);
        candidateById.set(id, { raw, issue: "batch_duplicate" });
      } else {
        candidateById.set(id, { raw, ...(parsed === undefined ? {} : { parsed }), ...(issue === undefined ? {} : { issue }) });
      }
    }

    const returnedIds = requestedIds.filter((id) => candidateById.has(id));
    const missingIds = requestedIds.filter((id) => !candidateById.has(id));
    const suspiciousIds = requestedIds.filter((id) => candidateById.get(id)?.issue !== undefined);
    const conversations: RetrievedConversationDetail[] = [];
    for (const conversation of group) {
      const candidate = candidateById.get(conversation.conversationId);
      if (!candidate || candidate.issue || !candidate.parsed) {
        conversations.push(await this.fetchSingle(conversation, candidate?.issue ?? "batch_missing"));
      } else {
        conversations.push({
          inventory: conversation,
          detail: candidate.parsed,
          raw: candidate.raw,
          source: "batch",
          correlationId: response.correlationId,
          responseBytes: response.responseBytes,
        });
      }
    }
    return {
      batch: {
        requestedConversationIds: requestedIds,
        returnedConversationIds: returnedIds,
        missingConversationIds: missingIds,
        suspiciousConversationIds: [...new Set([...suspiciousIds, ...duplicateIds])],
        response: response.body,
        responseBytes: response.responseBytes,
        correlationId: response.correlationId,
      },
      conversations,
    };
  }

  private async fetchSingle(conversation: InventoryConversation, fallbackReason: BatchFallbackReason): Promise<RetrievedConversationDetail> {
    const response = await this.transport.request({
      operation: "conversation_detail",
      parameters: { conversationId: conversation.conversationId },
    }, this.workspace.accountId, 120_000);
    const detail = parseConversationDetail(response.body);
    assertRequestedIdentity(conversation.conversationId, detail);
    const findings = graphFindings(detail);
    if (findings.length) throw new DetailCaptureError("SINGLE_GRAPH_INVALID", `Single-conversation detail for ${conversation.conversationId} is invalid: ${findings.join(", ")}`);
    return {
      inventory: conversation,
      detail,
      raw: response.body,
      source: "single",
      fallbackReason,
      correlationId: response.correlationId,
      responseBytes: response.responseBytes,
    };
  }

  private async fetchShared(conversation: InventoryConversation, shareId: string): Promise<RetrievedConversationDetail> {
    const response = await this.transport.request({ operation: "shared_detail", parameters: { shareId } }, this.workspace.accountId, 120_000);
    const detail = parseConversationDetail(response.body);
    const findings = graphFindings(detail);
    if (findings.length) throw new DetailCaptureError("SHARED_GRAPH_INVALID", `Shared detail ${shareId} is invalid: ${findings.join(", ")}`);
    return {
      inventory: conversation,
      detail,
      raw: response.body,
      source: "shared",
      correlationId: response.correlationId,
      responseBytes: response.responseBytes,
    };
  }
}

export function graphFindings(detail: ChatGptConversationDetail): string[] {
  const findings: string[] = [];
  const nodes = detail.mapping;
  const ids = new Set(Object.keys(nodes));
  if (ids.size === 0) findings.push("mapping_empty");
  if (detail.current_node && !ids.has(detail.current_node)) findings.push("current_node_missing");
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parent !== null && !ids.has(node.parent)) findings.push(`parent_missing:${id}`);
    for (const child of node.children) if (!ids.has(child)) findings.push(`child_missing:${id}`);
  }
  for (const start of ids) {
    const seen = new Set<string>();
    let current: string | null = start;
    while (current !== null) {
      if (seen.has(current)) {
        findings.push(`cycle:${start}`);
        break;
      }
      seen.add(current);
      current = nodes[current]?.parent ?? null;
    }
  }
  return [...new Set(findings)].sort();
}

export class DetailCaptureError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DetailCaptureError";
  }
}

function batchCandidates(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") throw new DetailCaptureError("INVALID_BATCH_ENVELOPE", "Batch response must be an array or object.");
  const object = value as Record<string, JsonValue>;
  if (Array.isArray(object.items)) return object.items;
  if (Array.isArray(object.conversations)) return object.conversations;
  return Object.values(object);
}

function hasOnlySafeCompactNullRoot(value: JsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const conversation = value as Record<string, JsonValue>;
  if (!conversation.mapping || typeof conversation.mapping !== "object" || Array.isArray(conversation.mapping)) return false;
  const mapping = conversation.mapping as Record<string, JsonValue>;
  const placeholders = Object.entries(mapping).filter(([, rawNode]) => {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) return false;
    const node = rawNode as Record<string, JsonValue>;
    return node.parent === undefined && node.message === undefined;
  });
  if (placeholders.length === 0) return true;
  if (placeholders.length !== 1) return false;
  const [placeholderId, rawPlaceholder] = placeholders[0]!;
  const placeholder = rawPlaceholder as Record<string, JsonValue>;
  if (!Object.keys(placeholder).every((key) => key === "id" || key === "children")) return false;
  if (conversation.current_node === placeholderId) return false;
  for (const [nodeId, rawNode] of Object.entries(mapping)) {
    if (nodeId === placeholderId || !rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) continue;
    const children = (rawNode as Record<string, JsonValue>).children;
    if (Array.isArray(children) && children.includes(placeholderId)) return false;
  }
  return true;
}

function looseConversationId(value: JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, JsonValue>;
  for (const candidate of [object.id, object.conversation_id]) {
    if (typeof candidate === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(candidate)) return candidate;
  }
  return null;
}

function assertRequestedIdentity(requestedId: string, detail: ChatGptConversationDetail): void {
  const returnedId = detail.id ?? detail.conversation_id;
  if (returnedId !== requestedId) throw new DetailCaptureError("DETAIL_ID_MISMATCH", `Requested ${requestedId} but ChatGPT returned ${returnedId ?? "no id"}.`);
}

function shareIdFor(conversation: InventoryConversation): string | null {
  if (!conversation.conversationId.startsWith("share_")) return null;
  return conversation.memberships.find((membership) => membership.scope === "shared")?.shareId ?? null;
}
