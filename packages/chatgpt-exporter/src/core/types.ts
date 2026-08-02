export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ConversationScope = "main" | "archived" | "project" | "shared";
export type ScopeTermination =
  | "declared_total_reached"
  | "empty_page"
  | "cursor_exhausted"
  | "recognized_empty_account";

export interface ScopeMembership {
  scope: ConversationScope;
  projectId?: string;
  projectName?: string;
  shareId?: string;
}

export interface InventoryConversation {
  logicalKey: string;
  conversationId: string;
  title: string | null;
  createTime: number | null;
  updateTime: number | null;
  memberships: ScopeMembership[];
  listingHashes: string[];
  listingRecords?: JsonObject[];
}

export interface InventoryProjectFile {
  logicalId: string;
  providerId: string;
  originalName: string | null;
  mediaType: string | null;
  byteSize: number | null;
  rawDescriptor: JsonValue;
}

export interface InventoryProject {
  projectId: string;
  name: string | null;
  description: string | null;
  instructions: string | null;
  createTime: number | null;
  updateTime: number | null;
  rawHash: string;
  files: InventoryProjectFile[];
}

export interface InventoryPageRecord {
  scope: ConversationScope;
  chainId: string;
  pageNumber: number;
  request: {
    offset?: number;
    limit?: number;
    cursor?: string;
    projectId?: string;
  };
  nextCursor: string | null;
  itemCount: number;
  responseBytes: number;
  rawResponseHash: string;
  orderedIdHash: string;
  duplicateCount: number;
  terminationReason: ScopeTermination | null;
}

export interface InventoryChain {
  chainId: string;
  scope: ConversationScope;
  projectId?: string;
  complete: boolean;
  terminationReason: ScopeTermination | null;
  pageCount: number;
  itemCount: number;
  uniqueConversationCount: number;
}

export interface ConversationInventory {
  schemaVersion: 1;
  provider: "chatgpt-web";
  workspaceFingerprint: string;
  generatedAt: string;
  complete: boolean;
  chains: InventoryChain[];
  pages: InventoryPageRecord[];
  projects?: InventoryProject[];
  absentConversations?: InventoryConversation[];
  conversations: InventoryConversation[];
}

export type CaptureStage = "pending" | "capturing" | "writing" | "complete" | "failed";

export interface CaptureJournalEntry {
  sequence: number;
  logicalKey: string;
  conversationId: string;
  from: CaptureStage | null;
  to: CaptureStage;
  occurredAt: string;
  runId: string;
  attempt: number;
  correlationId: string;
  rawHash?: string;
  completionHash?: string;
  error?: SafeFailure;
}

export interface SafeFailure {
  code: string;
  message: string;
  adapter?: string;
  status?: number;
  retryable: boolean;
  correlationId: string;
  responseBytes?: number;
}

export type NormalizedRole = "user" | "assistant" | "system" | "tool" | "unknown";

export interface NormalizedContentPart {
  kind:
    | "text"
    | "code"
    | "execution_output"
    | "citation"
    | "tool_call"
    | "tool_result"
    | "reasoning_summary"
    | "deep_research"
    | "canvas"
    | "asset"
    | "unknown";
  text?: string;
  language?: string;
  title?: string;
  url?: string;
  assetId?: string;
  assetPath?: string;
  raw: JsonValue;
}

export interface NormalizedMessage {
  id: string;
  nodeId: string;
  role: NormalizedRole;
  authorName: string | null;
  parentId: string | null;
  childIds: string[];
  createTime: number | null;
  updateTime: number | null;
  recipient: string | null;
  modelSlug: string | null;
  status: string | null;
  endTurn: boolean | null;
  selected: boolean;
  parts: NormalizedContentPart[];
  metadata: JsonValue;
  extensions: { chatgpt: JsonValue };
}

export interface NormalizedNode {
  id: string;
  messageId: string | null;
  parentId: string | null;
  childIds: string[];
  raw: JsonValue;
}

export interface ValidationFinding {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  nodeId?: string;
  messageId?: string;
}

export interface NormalizedConversation {
  schemaVersion: 1;
  normalizerVersion: string;
  provider: "chatgpt-web";
  logicalKey: string;
  conversationId: string;
  workspaceFingerprint: string;
  title: string | null;
  createTime: number | null;
  updateTime: number | null;
  currentNodeId: string | null;
  rootNodeIds: string[];
  memberships: ScopeMembership[];
  nodes: NormalizedNode[];
  messages: NormalizedMessage[];
  findings: ValidationFinding[];
  extensions: { chatgpt: JsonValue };
}

export type AssetStatus = "pending" | "complete" | "failed" | "not_requested";

export interface AssetRecord {
  logicalId: string;
  providerId: string | null;
  sourceMessageId: string | null;
  kind: "upload" | "generated_image" | "audio" | "video" | "canvas" | "research" | "inline" | "unknown";
  originalName: string | null;
  safeName: string | null;
  mediaType: string | null;
  byteSize: number | null;
  sha256: string | null;
  relativePath: string | null;
  adapter: string | null;
  status: AssetStatus;
  failure?: SafeFailure;
  rawDescriptor: JsonValue;
}

export interface ConversationAssetIndex {
  schemaVersion: 1;
  conversationId: string;
  status: "complete" | "partial" | "not_requested";
  assets: AssetRecord[];
}

export interface ProjectAssetIndex {
  schemaVersion: 1;
  projectId: string;
  status: "complete" | "partial" | "not_requested";
  assets: AssetRecord[];
}

export interface WorkspaceSelection {
  accountId: string;
  workspaceFingerprint: string;
  label: string;
  kind: "personal" | "business" | "enterprise" | "unknown";
}

export interface AccountArtifact {
  schemaVersion: 1;
  kind: "memory" | "custom_instructions" | "settings" | "beta_features" | "session_metadata";
  workspaceFingerprint: string;
  capturedAt: string;
  rawHash: string;
  value: JsonValue;
}

export interface ArchiveManifest {
  schemaVersion: 1;
  provider: "chatgpt-web";
  workspaceFingerprint: string;
  selectedScopes: ConversationScope[];
  extensionVersion: string;
  normalizerVersion: string;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  currentIndexHashes: Record<string, string>;
}
