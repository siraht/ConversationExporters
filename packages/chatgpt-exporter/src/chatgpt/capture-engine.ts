import { CaptureStore, type RawCompletionMarker } from "../core/capture-store";
import type { ArchiveFileSystem } from "../core/filesystem";
import { sha256Hex } from "../core/hash";
import { renderConversationMarkdown } from "../core/markdown";
import { conversationBasePath } from "../core/paths";
import { parseJson, prettyJson } from "../core/serialization";
import type { ConversationInventory, InventoryConversation, InventoryProject, JsonValue, ProjectAssetIndex, SafeFailure } from "../core/types";
import { ChatGptDetailFetcher, type RawBatchCapture, type RetrievedConversationDetail } from "./capture";
import type { ChatGptTransport, DiscoveredWorkspace } from "./client";
import { parseConversationDetail } from "./envelopes";
import { NORMALIZER_VERSION, normalizeConversation } from "./normalize";
import { ChatGptAssetManager } from "./assets";
import { AccountArtifactCapture } from "./account-artifacts";

export interface ConversationCompletionMarker {
  schemaVersion: 1;
  provider: "chatgpt-web";
  logicalKey: string;
  conversationId: string;
  workspaceFingerprint: string;
  listingHashes: string[];
  rawMarkerHash: string;
  detailHash: string;
  normalizedHash: string;
  markdownHash: string;
  assetsHash: string;
  assetStatus: "complete" | "partial" | "not_requested";
  normalizerVersion: string;
  completedAt: string;
}

export interface CaptureRunResult {
  runId: string;
  inventoryCount: number;
  capturedCount: number;
  rebuiltCount: number;
  skippedCount: number;
  failedCount: number;
  partialAssetCount: number;
  projectAssetCount: number;
  partialProjectAssetCount: number;
  projectAssetStatus: "complete" | "partial" | "not_requested";
  accountArtifactStatus: "complete" | "partial" | "not_requested";
}

interface ProjectAssetCompletionMarker {
  schemaVersion: 1;
  provider: "chatgpt-web";
  projectId: string;
  projectRawHash: string;
  assetsHash: string;
  status: "complete" | "partial" | "not_requested";
  completedAt: string;
}

export interface ConversationCaptureProgress {
  phase: "capturing" | "writing" | "complete" | "failed";
  completed: number;
  total: number;
  conversationId: string;
}

export class ChatGptCaptureEngine {
  private readonly now: () => Date;

  constructor(private readonly options: {
    transport: ChatGptTransport;
    filesystem: ArchiveFileSystem;
    workspace: DiscoveredWorkspace;
    runId: string;
    batchSize?: number;
    now?: () => Date;
    onProgress?: (progress: ConversationCaptureProgress) => void;
    includeAssets?: boolean;
    includeAccountArtifacts?: boolean;
    refreshAccountArtifacts?: boolean;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<CaptureRunResult> {
    const inventory = this.requireInventory(parseJson<ConversationInventory>(await this.options.filesystem.readText("inventory.json")));
    const store = new CaptureStore(this.options.filesystem, this.options.runId, this.options.workspace.workspaceFingerprint, this.now);
    await store.start();
    const result: CaptureRunResult = {
      runId: this.options.runId,
      inventoryCount: inventory.conversations.length,
      capturedCount: 0,
      rebuiltCount: 0,
      skippedCount: 0,
      failedCount: 0,
      partialAssetCount: 0,
      projectAssetCount: 0,
      partialProjectAssetCount: 0,
      projectAssetStatus: this.options.includeAssets === false ? "not_requested" : "complete",
      accountArtifactStatus: "not_requested",
    };
    if (this.options.includeAccountArtifacts !== false) {
      result.accountArtifactStatus = (await new AccountArtifactCapture({
        transport: this.options.transport,
        filesystem: this.options.filesystem,
        workspace: this.options.workspace,
        now: this.now,
      }).capture(this.options.refreshAccountArtifacts === true)).status;
    }
    const assetManager = new ChatGptAssetManager({
      transport: this.options.transport,
      filesystem: this.options.filesystem,
      workspace: this.options.workspace,
    });
    const projectAssetResult = await this.captureProjectAssets(inventory.projects ?? [], assetManager);
    result.projectAssetCount = projectAssetResult.assetCount;
    result.partialProjectAssetCount = projectAssetResult.partialProjectCount;
    result.projectAssetStatus = projectAssetResult.status;
    const needNetwork: InventoryConversation[] = [];
    const rebuild: Array<{ conversation: InventoryConversation; rawMarker: RawCompletionMarker }> = [];

    for (const conversation of inventory.conversations) {
      if (await this.validCompletion(conversation)) {
        await store.transition(conversation, "complete", { attempt: 0, correlationId: "resume-verified" });
        result.skippedCount += 1;
        continue;
      }
      await store.transition(conversation, "pending", { attempt: 1, correlationId: "queued" });
      await store.transition(conversation, "capturing", { attempt: 1, correlationId: "resume-or-fetch" });
      const rawMarker = await store.validRawMarker(conversation);
      if (rawMarker) rebuild.push({ conversation, rawMarker });
      else needNetwork.push(conversation);
    }

    if (needNetwork.length) {
      const completedThisRun = new Set<string>();
      try {
        await new ChatGptDetailFetcher(this.options.transport, this.options.workspace, this.options.batchSize ?? 10).fetchAll(needNetwork, async (checkpoint) => {
          const batchByConversation = mapBatches(checkpoint.batches);
          for (const retrieved of checkpoint.conversations) {
            const assetStatus = await this.persistAndDerive(store, assetManager, retrieved, batchByConversation.get(retrieved.inventory.conversationId));
            if (assetStatus === "partial") result.partialAssetCount += 1;
            result.capturedCount += 1;
            completedThisRun.add(retrieved.inventory.logicalKey);
            this.progress("complete", result, retrieved.inventory.conversationId);
          }
        });
      } catch (error) {
        const failure = safeFailure(error);
        for (const conversation of needNetwork.filter((item) => !completedThisRun.has(item.logicalKey))) {
          await store.transition(conversation, "failed", { attempt: 1, correlationId: failure.correlationId, error: failure });
          result.failedCount += 1;
          this.progress("failed", result, conversation.conversationId);
        }
        await this.writeRunReport(result);
        throw error;
      }
    }

    for (const item of rebuild) {
      try {
        const rawText = await this.options.filesystem.readText(item.rawMarker.detailPath);
        if (rawText === undefined) throw new Error(`Validated raw detail disappeared for ${item.conversation.conversationId}.`);
        const raw = JSON.parse(rawText) as JsonValue;
        const detail = parseConversationDetail(raw);
        const assetStatus = await this.derive(store, assetManager, item.conversation, detail, item.rawMarker, "resume-rebuild");
        if (assetStatus === "partial") result.partialAssetCount += 1;
        result.rebuiltCount += 1;
        this.progress("complete", result, item.conversation.conversationId);
      } catch (error) {
        const failure = safeFailure(error);
        await store.transition(item.conversation, "failed", { attempt: 1, correlationId: failure.correlationId, error: failure });
        result.failedCount += 1;
        this.progress("failed", result, item.conversation.conversationId);
        await this.writeRunReport(result);
        throw error;
      }
    }
    await this.writeAssetIndex(inventory);
    if (result.capturedCount + result.rebuiltCount + result.skippedCount + result.failedCount !== result.inventoryCount) {
      throw new Error("Capture result counts do not reconcile with inventory.");
    }
    await this.writeRunReport(result);
    return result;
  }

  private async persistAndDerive(store: CaptureStore, assetManager: ChatGptAssetManager, retrieved: RetrievedConversationDetail, batch: RawBatchCapture | undefined): Promise<"complete" | "partial" | "not_requested"> {
    const conversation = retrieved.inventory;
    for (const listing of conversation.listingRecords ?? []) await store.writeRawRevision(conversation.conversationId, "listing", listing);
    const detailRevision = await store.writeRawRevision(conversation.conversationId, "detail", retrieved.raw);
    const batchRevision = batch === undefined ? undefined : await store.writeRawRevision(conversation.conversationId, "batch", batch.response);
    await store.transition(conversation, "writing", {
      attempt: 1,
      correlationId: retrieved.correlationId,
      rawHash: detailRevision.hash,
    });
    const rawMarker: RawCompletionMarker = {
      schemaVersion: 1,
      provider: "chatgpt-web",
      logicalKey: conversation.logicalKey,
      conversationId: conversation.conversationId,
      workspaceFingerprint: this.options.workspace.workspaceFingerprint,
      listingHashes: [...conversation.listingHashes],
      detailHash: detailRevision.hash,
      detailPath: detailRevision.path,
      batchHash: batchRevision?.hash ?? null,
      batchPath: batchRevision?.path ?? null,
      retrievalSource: retrieved.source,
      completedAt: this.now().toISOString(),
    };
    await store.writeRawMarker(rawMarker);
    return this.derive(store, assetManager, conversation, retrieved.detail, rawMarker, retrieved.correlationId, true);
  }

  private async derive(
    store: CaptureStore,
    assetManager: ChatGptAssetManager,
    conversation: InventoryConversation,
    detail: ReturnType<typeof parseConversationDetail>,
    rawMarker: RawCompletionMarker,
    correlationId: string,
    alreadyWriting = false,
  ): Promise<"complete" | "partial" | "not_requested"> {
    if (!alreadyWriting) await store.transition(conversation, "writing", { attempt: 1, correlationId, rawHash: rawMarker.detailHash });
    this.options.onProgress?.({ phase: "writing", completed: 0, total: 0, conversationId: conversation.conversationId });
    const normalized = normalizeConversation(detail, conversation, this.options.workspace.workspaceFingerprint);
    if (normalized.findings.some((finding) => finding.severity === "error")) throw new Error(`Normalization produced graph errors for ${conversation.conversationId}.`);
    const assets = this.options.includeAssets === false
      ? { schemaVersion: 1 as const, conversationId: conversation.conversationId, status: "not_requested" as const, assets: [] }
      : await assetManager.capture(detail, conversation);
    linkNormalizedAssets(normalized, assets.assets);
    const normalizedText = prettyJson(normalized);
    const markdown = renderConversationMarkdown(normalized);
    const assetsText = prettyJson(assets);
    const rawMarkerText = prettyJson(rawMarker);
    const marker: ConversationCompletionMarker = {
      schemaVersion: 1,
      provider: "chatgpt-web",
      logicalKey: conversation.logicalKey,
      conversationId: conversation.conversationId,
      workspaceFingerprint: this.options.workspace.workspaceFingerprint,
      listingHashes: [...conversation.listingHashes],
      rawMarkerHash: await sha256Hex(rawMarkerText),
      detailHash: rawMarker.detailHash,
      normalizedHash: await sha256Hex(normalizedText),
      markdownHash: await sha256Hex(markdown),
      assetsHash: await sha256Hex(assetsText),
      assetStatus: assets.status,
      normalizerVersion: NORMALIZER_VERSION,
      completedAt: this.now().toISOString(),
    };
    await store.writeDerivedText(conversation.conversationId, "conversation.json", normalizedText);
    await store.writeDerivedText(conversation.conversationId, "conversation.md", markdown);
    await store.writeDerivedText(conversation.conversationId, "assets.json", assetsText);
    await store.writeDerivedText(conversation.conversationId, "metadata.json", prettyJson({
      logicalKey: conversation.logicalKey,
      memberships: conversation.memberships,
      listingHashes: conversation.listingHashes,
      detailHash: rawMarker.detailHash,
      normalizerVersion: NORMALIZER_VERSION,
    }));
    const markerText = prettyJson(marker);
    await store.writeDerivedText(conversation.conversationId, "complete.json", markerText);
    await store.transition(conversation, "complete", {
      attempt: 1,
      correlationId,
      completionHash: await sha256Hex(markerText),
    });
    return assets.status;
  }

  private requireInventory(inventory: ConversationInventory | undefined): ConversationInventory {
    if (!inventory || inventory.schemaVersion !== 1 || inventory.provider !== "chatgpt-web" || !inventory.complete) throw new Error("A complete ChatGPT inventory is required before capture.");
    if (inventory.workspaceFingerprint !== this.options.workspace.workspaceFingerprint) throw new Error("Inventory workspace fingerprint does not match the selected workspace.");
    if (!inventory.chains.every((chain) => chain.complete && chain.terminationReason !== null)) throw new Error("Inventory contains a non-terminal chain.");
    return inventory;
  }

  private async validCompletion(conversation: InventoryConversation): Promise<boolean> {
    const base = conversationBasePath(conversation.conversationId);
    const marker = parseJson<ConversationCompletionMarker>(await this.options.filesystem.readText(`${base}/complete.json`));
    if (!marker
      || marker.schemaVersion !== 1
      || marker.provider !== "chatgpt-web"
      || marker.logicalKey !== conversation.logicalKey
      || marker.workspaceFingerprint !== this.options.workspace.workspaceFingerprint
      || marker.normalizerVersion !== NORMALIZER_VERSION
      || (this.options.includeAssets !== false && marker.assetStatus !== "complete")
      || !sameSet(marker.listingHashes, conversation.listingHashes)) return false;
    const files: Array<[string, string]> = [
      [`${base}/raw-complete.json`, marker.rawMarkerHash],
      [`${base}/conversation.json`, marker.normalizedHash],
      [`${base}/conversation.md`, marker.markdownHash],
      [`${base}/assets.json`, marker.assetsHash],
    ];
    for (const [path, hash] of files) {
      const content = await this.options.filesystem.readText(path);
      if (content === undefined || await sha256Hex(content) !== hash) return false;
    }
    return true;
  }

  private async writeRunReport(result: CaptureRunResult): Promise<void> {
    await this.options.filesystem.writeTextAtomic(`reports/capture-${this.options.runId}.json`, prettyJson(result));
  }

  private async writeAssetIndex(inventory: ConversationInventory): Promise<void> {
    const rows: Array<Record<string, unknown>> = [];
    for (const conversation of inventory.conversations) {
      const value = parseJson<{ assets?: Array<Record<string, unknown>> }>(await this.options.filesystem.readText(`${conversationBasePath(conversation.conversationId)}/assets.json`));
      for (const asset of value?.assets ?? []) rows.push({ logicalKey: conversation.logicalKey, conversationId: conversation.conversationId, ...asset });
    }
    for (const project of inventory.projects ?? []) {
      const value = parseJson<{ assets?: Array<Record<string, unknown>> }>(await this.options.filesystem.readText(`${projectBasePath(project.projectId)}/assets.json`));
      for (const asset of value?.assets ?? []) rows.push({ logicalKey: `${this.options.workspace.workspaceFingerprint}/project/${project.projectId}`, projectId: project.projectId, ...asset });
    }
    rows.sort((left, right) => `${left.logicalKey}\0${left.logicalId}`.localeCompare(`${right.logicalKey}\0${right.logicalId}`));
    await this.options.filesystem.writeTextAtomic("indexes/assets.jsonl", rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  }

  private async captureProjectAssets(projects: InventoryProject[], assetManager: ChatGptAssetManager): Promise<{
    status: "complete" | "partial" | "not_requested";
    assetCount: number;
    partialProjectCount: number;
  }> {
    let assetCount = 0;
    let partialProjectCount = 0;
    for (const project of projects) {
      const base = projectBasePath(project.projectId);
      const existing = parseJson<ProjectAssetCompletionMarker>(await this.options.filesystem.readText(`${base}/complete.json`));
      const existingAssets = await this.options.filesystem.readText(`${base}/assets.json`);
      const expectedStatus = this.options.includeAssets === false ? "not_requested" : "complete";
      if (existing
        && existing.schemaVersion === 1
        && existing.provider === "chatgpt-web"
        && existing.projectId === project.projectId
        && existing.projectRawHash === project.rawHash
        && existing.status === expectedStatus
        && existingAssets !== undefined
        && await sha256Hex(existingAssets) === existing.assetsHash) {
        const parsed = parseJson<ProjectAssetIndex>(existingAssets);
        assetCount += parsed?.assets.length ?? 0;
        continue;
      }
      const assets: ProjectAssetIndex = this.options.includeAssets === false
        ? { schemaVersion: 1, projectId: project.projectId, status: "not_requested", assets: [] }
        : await assetManager.captureProject(project);
      const assetsText = prettyJson(assets);
      const marker: ProjectAssetCompletionMarker = {
        schemaVersion: 1,
        provider: "chatgpt-web",
        projectId: project.projectId,
        projectRawHash: project.rawHash,
        assetsHash: await sha256Hex(assetsText),
        status: assets.status,
        completedAt: this.now().toISOString(),
      };
      await this.options.filesystem.writeTextAtomic(`${base}/metadata.json`, prettyJson(project));
      await this.options.filesystem.writeTextAtomic(`${base}/assets.json`, assetsText);
      await this.options.filesystem.writeTextAtomic(`${base}/complete.json`, prettyJson(marker));
      assetCount += assets.assets.length;
      if (assets.status === "partial") partialProjectCount += 1;
    }
    return {
      status: this.options.includeAssets === false ? "not_requested" : partialProjectCount > 0 ? "partial" : "complete",
      assetCount,
      partialProjectCount,
    };
  }

  private progress(phase: ConversationCaptureProgress["phase"], result: CaptureRunResult, conversationId: string): void {
    this.options.onProgress?.({
      phase,
      completed: result.capturedCount + result.rebuiltCount + result.skippedCount,
      total: result.inventoryCount,
      conversationId,
    });
  }
}

function projectBasePath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(projectId)) throw new Error("Project identifier is unsafe for archive paths.");
  return `projects/${projectId}`;
}

function mapBatches(batches: RawBatchCapture[]): Map<string, RawBatchCapture> {
  const output = new Map<string, RawBatchCapture>();
  for (const batch of batches) for (const id of batch.requestedConversationIds) output.set(id, batch);
  return output;
}

function safeFailure(error: unknown): SafeFailure {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; retryable?: unknown; correlationId?: unknown }
    : null;
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "CAPTURE_FAILED",
    message: error instanceof Error ? error.message : "Conversation capture failed.",
    retryable: candidate?.retryable === true,
    correlationId: typeof candidate?.correlationId === "string" ? candidate.correlationId : crypto.randomUUID(),
  };
}

function sameSet(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
}

function linkNormalizedAssets(normalized: ReturnType<typeof normalizeConversation>, assets: Array<{ providerId: string | null; relativePath: string | null; status: string }>): void {
  const unused = assets.filter((asset) => asset.relativePath && asset.status === "complete");
  for (const message of normalized.messages) {
    for (const part of message.parts) {
      if (part.kind !== "asset" || !part.assetId) continue;
      const providerId = part.assetId.replace(/^(?:sediment|file-service):\/\//, "");
      let index = unused.findIndex((asset) => asset.providerId === providerId);
      if (index < 0) index = unused.findIndex((asset) => asset.providerId === null);
      if (index >= 0) part.assetPath = unused.splice(index, 1)[0]!.relativePath!;
    }
  }
}
