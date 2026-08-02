export const ARCHIVE_SCHEMA_VERSION = 1 as const;
export const NORMALIZED_SCHEMA_VERSION = 1 as const;
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ConversationListEntry {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  starred?: boolean;
  temporary?: boolean;
  workspaceIds: string[];
  listingHash: string;
  raw: JsonObject;
}

export interface InventoryPageRecord {
  pageNumber: number;
  workspaceId?: string;
  requestedPageToken?: string;
  returnedPageToken?: string;
  itemCount: number;
  responseBytes: number;
  responseHash: string;
}

export interface ConversationInventory {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  provider: "grok";
  capturedAt: string;
  completedAt?: string;
  complete: boolean;
  pageSize: number;
  pages: InventoryPageRecord[];
  conversations: ConversationListEntry[];
  warnings: ValidationFinding[];
}

export interface RawResponseBatch {
  batchNumber: number;
  requestedIds: string[];
  cursor?: string;
  nextCursor?: string;
  responseHash: string;
  raw: JsonValue;
}

export interface RawConversationCapture {
  provider: "grok";
  capturedAt: string;
  listingEntry: JsonObject;
  discoveredWorkspaceIds?: string[];
  metadata: JsonValue;
  responseNodes: JsonValue;
  responseBatches: RawResponseBatch[];
}

export interface SupportingListPage {
  pageNumber: number;
  requestedPageToken?: string;
  returnedPageToken?: string;
  itemCount: number;
  responseHash: string;
  raw: JsonValue;
}

export interface SupportingCollectionCapture {
  complete: boolean;
  pages: SupportingListPage[];
  items: JsonValue[];
  findings: ValidationFinding[];
}

export interface SupportingMetadataCapture {
  capturedAt: string;
  assets?: SupportingCollectionCapture;
  workspaces?: SupportingCollectionCapture;
  workspaceDetails: Record<string, JsonValue>;
}

export type MessageRole = "user" | "assistant" | "system" | "tool" | "unknown";

export interface NormalizedCitation {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
  raw?: JsonObject;
}

export interface NormalizedAttachment {
  id?: string;
  name?: string;
  mediaType?: string;
  sourceUrl?: string;
  localPath?: string;
  contentHash?: string;
  size?: number;
  kind: "image" | "video" | "audio" | "document" | "code" | "unknown";
  raw?: JsonObject;
}

export interface AssetDownloadRecord {
  conversationId: string;
  messageId: string;
  attachmentId?: string;
  sourceUrl?: string;
  finalUrl?: string;
  localPath?: string;
  mediaType?: string;
  contentHash?: string;
  size?: number;
  status: "complete" | "failed" | "missing_url";
  error?: SanitizedError;
}

export interface NormalizedMessage {
  id: string;
  role: MessageRole;
  senderLabel?: string;
  createdAt?: string;
  model?: string;
  text: string;
  markdown: string;
  parentId?: string;
  childIds: string[];
  selected?: boolean;
  citations: NormalizedCitation[];
  attachments: NormalizedAttachment[];
  rawResponseId?: string;
  extensions: JsonObject;
  warnings: ValidationFinding[];
}

export interface NormalizedConversation {
  schemaVersion: typeof NORMALIZED_SCHEMA_VERSION;
  provider: "grok";
  id: string;
  title: string;
  sourceUrl: string;
  createdAt?: string;
  updatedAt?: string;
  capturedAt: string;
  starred?: boolean;
  temporary?: boolean;
  workspaceIds: string[];
  rootMessageIds: string[];
  messages: NormalizedMessage[];
  extensions: JsonObject;
  provenance: {
    rawCaptureHash: string;
    sourcePaths: string[];
  };
  warnings: ValidationFinding[];
}

export type FindingSeverity = "info" | "warning" | "error";

export interface ValidationFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  conversationId?: string;
  responseId?: string;
  assetId?: string;
  details?: JsonObject;
}

export interface ConversationValidation {
  conversationId: string;
  valid: boolean;
  expectedResponseIds: string[];
  capturedResponseIds: string[];
  missingResponseIds: string[];
  unexpectedResponseIds: string[];
  duplicateResponseIds: string[];
  findings: ValidationFinding[];
}

export type ConversationRunState =
  | "pending"
  | "capturing"
  | "writing"
  | "complete"
  | "retryable_failure"
  | "terminal_failure"
  | "cancelled"
  | "unchanged";

export interface ConversationJournalEntry {
  conversationId: string;
  state: ConversationRunState;
  attemptCount: number;
  firstAttemptedAt?: string;
  updatedAt: string;
  remoteUpdatedAt?: string;
  listingHash: string;
  rawCaptureHash?: string;
  completionMarkerHash?: string;
  error?: SanitizedError;
}

export interface RunJournal {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  runId: string;
  provider: "grok";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  state: "inventory" | "capture" | "validation" | "complete" | "paused" | "cancelled" | "failed";
  inventoryHash?: string;
  inventoryComplete: boolean;
  conversations: Record<string, ConversationJournalEntry>;
  findings: ValidationFinding[];
}

export interface ArchiveManifest {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  provider: "grok";
  createdAt: string;
  updatedAt: string;
  accountFingerprint: string;
  latestRunId?: string;
  conversationCount: number;
  completeConversationCount: number;
  missingRemoteConversationIds: string[];
}

export interface SanitizedError {
  name: string;
  message: string;
  code?: string;
  httpStatus?: number;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface CaptureSettings {
  pageSize: number;
  responseBatchSize: number;
  requestDelayMs: number;
  maxRetries: number;
  maxPages: number;
  maxResponseBytes: number;
  includeAssets: boolean;
  includeWorkspaces: boolean;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  pageSize: 100,
  responseBatchSize: 50,
  requestDelayMs: 500,
  maxRetries: 5,
  maxPages: 10_000,
  maxResponseBytes: 128 * 1024 * 1024,
  includeAssets: true,
  includeWorkspaces: true,
};

export interface ApiRequest {
  requestId: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  path: string;
  method: "GET" | "POST";
  body?: JsonValue;
  timeoutMs: number;
}

export interface ApiSuccessResponse {
  requestId: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  ok: true;
  status: number;
  body: JsonValue;
  responseBytes: number;
}

export interface ApiFailureResponse {
  requestId: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  ok: false;
  status?: number;
  error: SanitizedError;
}

export type ApiResponse = ApiSuccessResponse | ApiFailureResponse;

export interface ApiTransport {
  request(request: Omit<ApiRequest, "requestId" | "protocolVersion">): Promise<ApiSuccessResponse>;
}

export interface CancellationSignal {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
  waitIfPaused?(): Promise<void>;
}

export interface ProgressEvent {
  phase: "inventory" | "capture" | "write" | "asset" | "validation";
  message: string;
  completed?: number;
  total?: number;
  conversationId?: string;
}
