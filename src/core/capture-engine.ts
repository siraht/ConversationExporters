import { GrokExporterError, sanitizeError } from "./errors";
import { downloadConversationAssets, type AssetDownloadResult, type AssetFetcher } from "./assets";
import type { ArchiveFileSystem } from "./filesystem";
import { hashJson } from "./hash";
import { renderConversationMarkdown } from "./markdown";
import { firstString } from "./json";
import { conversationBasePath, safePathSegment } from "./paths";
import { jsonLine, parseJson, prettyJson, toJsonValue } from "./serialization";
import {
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
  type AssetDownloadRecord,
  type CancellationSignal,
  type ConversationInventory,
  type ConversationJournalEntry,
  type ConversationListEntry,
  type ConversationValidation,
  type NormalizedConversation,
  type NormalizedAttachment,
  type ProgressEvent,
  type RunJournal,
  type SanitizedError,
  type ValidationFinding,
} from "./types";
import { validateConversationCapture, validateInventory } from "./validation";
import type { GrokClient } from "../grok/client";
import { normalizeConversation } from "../grok/normalize";

export interface CompletionMarker {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  conversationId: string;
  listingHash: string;
  remoteUpdatedAt?: string;
  rawCaptureHash: string;
  normalizedHash: string;
  completedAt: string;
  validationValid: true;
  messageCount: number;
  assetStatus: "not_requested" | "complete" | "partial";
}

export interface RunSummary {
  runId: string;
  complete: boolean;
  inventoryCount: number;
  completeCount: number;
  unchangedCount: number;
  failedCount: number;
  assetFailureCount: number;
  missingRemoteConversationIds: string[];
  failures: Array<{ conversationId: string; error: SanitizedError }>;
}

export interface CaptureEngineOptions {
  client: GrokClient;
  filesystem: ArchiveFileSystem;
  cancellation?: CancellationSignal;
  onProgress?: (event: ProgressEvent) => void;
  now?: () => Date;
  idFactory?: () => string;
  assetFetcher?: AssetFetcher;
}

export class CaptureEngine {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private journal?: RunJournal;

  constructor(private readonly options: CaptureEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async run(): Promise<RunSummary> {
    const startedAt = this.now().toISOString();
    const runId = safePathSegment(`${startedAt.replace(/[-:.]/g, "")}-${this.idFactory().slice(0, 8)}`, "run", 80);
    const previousInventory = parseJson<ConversationInventory>(await this.options.filesystem.readText("inventory.json"));
    const archive = await this.loadOrCreateArchive(startedAt);
    const journal: RunJournal = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      runId,
      provider: "grok",
      startedAt,
      updatedAt: startedAt,
      state: "inventory",
      inventoryComplete: false,
      conversations: {},
      findings: [],
    };
    this.journal = journal;
    await this.writeJournal();

    try {
      const inventory = await this.options.client.inventory();
      const inventoryFindings = validateInventory(inventory);
      journal.inventoryComplete = inventoryFindings.every((finding) => finding.severity !== "error");
      journal.inventoryHash = await hashJson(toJsonValue(inventory));
      journal.findings.push(...inventoryFindings);
      journal.state = "capture";
      await this.options.filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
      const supportingMetadata = await this.options.client.captureSupportingMetadata();
      await this.options.filesystem.writeTextAtomic("source/supporting-metadata.json", prettyJson(supportingMetadata));
      if (supportingMetadata.assets) {
        await this.options.filesystem.writeTextAtomic("source/assets.json", prettyJson(supportingMetadata.assets));
      }
      if (supportingMetadata.workspaces) {
        await this.options.filesystem.writeTextAtomic("source/workspaces.json", prettyJson(supportingMetadata.workspaces));
        for (const [workspaceId, detail] of Object.entries(supportingMetadata.workspaceDetails)) {
          await this.options.filesystem.writeTextAtomic(`source/workspaces/${safePathSegment(workspaceId, "workspace", 160)}/workspace.json`, prettyJson(detail));
        }
      }

      for (const conversation of inventory.conversations) {
        journal.conversations[conversation.id] = await this.initialJournalEntry(conversation, startedAt);
      }
      await this.writeJournal();

      if (!journal.inventoryComplete) {
        throw new GrokExporterError("Inventory validation failed; conversation capture was not started.", {
          code: "INVENTORY_VALIDATION_FAILED",
        });
      }

      await this.capturePass(inventory.conversations, false);
      await this.capturePass(
        inventory.conversations.filter((conversation) => journal.conversations[conversation.id]?.state === "retryable_failure"),
        true,
      );

      for (const entry of Object.values(journal.conversations)) {
        if (entry.state === "retryable_failure") entry.state = "terminal_failure";
      }
      journal.state = "validation";
      await this.writeJournal();

      const missingRemoteConversationIds = previousInventory === undefined
        ? []
        : previousInventory.conversations
          .map((conversation) => conversation.id)
          .filter((id) => !inventory.conversations.some((conversation) => conversation.id === id));
      const summary = await this.writeFinalReports(inventory, archive, missingRemoteConversationIds);
      journal.state = summary.complete ? "complete" : "failed";
      journal.completedAt = this.now().toISOString();
      await this.writeJournal();
      return summary;
    } catch (error) {
      journal.updatedAt = this.now().toISOString();
      journal.state = this.options.cancellation?.cancelled ? "cancelled" : "failed";
      journal.findings.push({
        code: "RUN_ABORTED",
        severity: "error",
        message: sanitizeError(error).message,
      });
      await this.writeJournal();
      throw error;
    }
  }

  private async capturePass(conversations: ConversationListEntry[], finalPass: boolean): Promise<void> {
    const journal = this.requireJournal();
    for (let index = 0; index < conversations.length; index += 1) {
      await this.options.cancellation?.waitIfPaused?.();
      this.options.cancellation?.throwIfCancelled();
      const conversation = conversations[index]!;
      const entry = journal.conversations[conversation.id]!;
      if (entry.state === "unchanged" || entry.state === "complete") continue;
      this.options.onProgress?.({
        phase: "capture",
        message: `${finalPass ? "Retrying" : "Capturing"} ${conversation.title}`,
        completed: index,
        total: conversations.length,
        conversationId: conversation.id,
      });
      await this.captureOne(conversation, entry, finalPass);
    }
  }

  private async captureOne(conversation: ConversationListEntry, entry: ConversationJournalEntry, finalPass: boolean): Promise<void> {
    entry.state = "capturing";
    entry.attemptCount += 1;
    entry.firstAttemptedAt ??= this.now().toISOString();
    entry.updatedAt = this.now().toISOString();
    delete entry.error;
    await this.writeJournal();

    try {
      const { capture, findings: captureFindings } = await this.options.client.captureConversation(
        conversation.raw,
        conversation.workspaceIds,
      );
      const { conversation: normalized, findings: normalizationFindings } = await normalizeConversation(capture);
      const basePath = conversationBasePath(conversation.id);
      const assetResult = await downloadConversationAssets({
        conversation: normalized,
        basePath,
        filesystem: this.options.filesystem,
        ...(this.options.assetFetcher === undefined ? {} : { fetcher: this.options.assetFetcher }),
        resolve: (attachment) => this.resolveAssetUrl(attachment),
        ...(this.options.cancellation === undefined ? {} : { cancellation: this.options.cancellation }),
        ...(this.options.onProgress === undefined ? {} : { onProgress: this.options.onProgress }),
      });
      const validation = validateConversationCapture(capture, normalized, [
        ...captureFindings,
        ...normalizationFindings,
        ...assetResult.findings,
      ]);
      entry.state = "writing";
      entry.updatedAt = this.now().toISOString();
      entry.rawCaptureHash = normalized.provenance.rawCaptureHash;
      await this.writeJournal();

      await this.writeConversationArtifacts(basePath, capture, normalized, validation, assetResult);
      if (!validation.valid) {
        throw new GrokExporterError("Conversation failed response-set or graph validation.", {
          code: "CONVERSATION_VALIDATION_FAILED",
          retryable: !finalPass,
        });
      }

      const normalizedHash = await hashJson(toJsonValue(normalized));
      const marker: CompletionMarker = {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        conversationId: conversation.id,
        listingHash: conversation.listingHash,
        rawCaptureHash: normalized.provenance.rawCaptureHash,
        normalizedHash,
        completedAt: this.now().toISOString(),
        validationValid: true,
        messageCount: normalized.messages.length,
        assetStatus: assetResult.status,
        ...(conversation.updatedAt === undefined ? {} : { remoteUpdatedAt: conversation.updatedAt }),
      };
      await this.options.filesystem.writeTextAtomic(`${basePath}/complete.json`, prettyJson(marker));
      entry.state = "complete";
      entry.completionMarkerHash = await hashJson(toJsonValue(marker));
      entry.updatedAt = this.now().toISOString();
      await this.writeJournal();
    } catch (error) {
      const sanitized = sanitizeError(error);
      entry.error = sanitized;
      entry.state = sanitized.retryable && !finalPass ? "retryable_failure" : "terminal_failure";
      entry.updatedAt = this.now().toISOString();
      await this.writeJournal();
    }
  }

  private async initialJournalEntry(conversation: ConversationListEntry, now: string): Promise<ConversationJournalEntry> {
    const marker = parseJson<CompletionMarker>(
      await this.options.filesystem.readText(`${conversationBasePath(conversation.id)}/complete.json`),
    );
    const unchanged = marker?.validationValid === true
      && marker.conversationId === conversation.id
      && marker.listingHash === conversation.listingHash;

    return {
      conversationId: conversation.id,
      state: unchanged ? "unchanged" : "pending",
      attemptCount: 0,
      updatedAt: now,
      listingHash: conversation.listingHash,
      ...(conversation.updatedAt === undefined ? {} : { remoteUpdatedAt: conversation.updatedAt }),
      ...(marker?.rawCaptureHash === undefined ? {} : { rawCaptureHash: marker.rawCaptureHash }),
      ...(unchanged ? { completionMarkerHash: await hashJson(toJsonValue(marker)) } : {}),
    };
  }

  private async resolveAssetUrl(attachment: NormalizedAttachment): Promise<string | undefined> {
    const generatedId = attachment.sourceUrl?.match(/\/generated\/([a-f0-9-]{16,})\//i)?.[1];
    const assetId = attachment.id ?? generatedId;
    if (!assetId) return undefined;
    try {
      const record = await this.options.client.fetchAssetRecord(assetId);
      const url = firstString(record, [["url"], ["downloadUrl"], ["download_url"], ["data", "url"]]);
      if (url) return url;
      const key = firstString(record, [["key"], ["data", "key"]]);
      return key ? `https://assets.grok.com/${key.replace(/^\/+/, "")}` : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeConversationArtifacts(
    basePath: string,
    capture: Awaited<ReturnType<GrokClient["captureConversation"]>>["capture"],
    normalized: NormalizedConversation,
    validation: ConversationValidation,
    assetResult: AssetDownloadResult,
  ): Promise<void> {
    await this.options.filesystem.writeTextAtomic(`${basePath}/source/listing-entry.json`, prettyJson(capture.listingEntry));
    await this.options.filesystem.writeTextAtomic(`${basePath}/source/conversation.json`, prettyJson(capture.metadata));
    await this.options.filesystem.writeTextAtomic(`${basePath}/source/response-nodes.json`, prettyJson(capture.responseNodes));
    for (const batch of capture.responseBatches) {
      const filename = `responses-${String(batch.batchNumber).padStart(4, "0")}.json`;
      await this.options.filesystem.writeTextAtomic(`${basePath}/source/${filename}`, prettyJson(batch.raw));
    }
    await this.options.filesystem.writeTextAtomic(`${basePath}/metadata.json`, prettyJson({
      provider: "grok",
      capturedAt: capture.capturedAt,
      rawCaptureHash: normalized.provenance.rawCaptureHash,
      sourcePaths: normalized.provenance.sourcePaths,
    }));
    await this.options.filesystem.writeTextAtomic(`${basePath}/conversation.json`, prettyJson(normalized));
    await this.options.filesystem.writeTextAtomic(`${basePath}/conversation.md`, renderConversationMarkdown(normalized, validation));
    await this.options.filesystem.writeTextAtomic(`${basePath}/validation.json`, prettyJson(validation));
    await this.options.filesystem.writeTextAtomic(`${basePath}/assets.json`, prettyJson(assetResult));
  }

  private async writeFinalReports(
    inventory: ConversationInventory,
    archive: ArchiveManifest,
    missingRemoteConversationIds: string[],
  ): Promise<RunSummary> {
    const journal = this.requireJournal();
    const failures = Object.values(journal.conversations)
      .filter((entry) => entry.state === "terminal_failure" || entry.state === "retryable_failure")
      .map((entry) => ({
        conversationId: entry.conversationId,
        error: entry.error ?? { name: "UnknownError", message: "Conversation did not complete.", retryable: false },
      }));
    const completeCount = Object.values(journal.conversations).filter((entry) => entry.state === "complete" || entry.state === "unchanged").length;
    const unchangedCount = Object.values(journal.conversations).filter((entry) => entry.state === "unchanged").length;
    const complete = journal.inventoryComplete && failures.length === 0 && completeCount === inventory.conversations.length;
    const assetRecords: AssetDownloadRecord[] = [];
    for (const conversation of inventory.conversations) {
      const result = parseJson<AssetDownloadResult>(
        await this.options.filesystem.readText(`${conversationBasePath(conversation.id)}/assets.json`),
      );
      if (result) assetRecords.push(...result.records);
    }
    const assetFailureCount = assetRecords.filter((record) => record.status !== "complete").length;
    const summary: RunSummary = {
      runId: journal.runId,
      complete,
      inventoryCount: inventory.conversations.length,
      completeCount,
      unchangedCount,
      failedCount: failures.length,
      assetFailureCount,
      missingRemoteConversationIds,
      failures,
    };

    const validations: ConversationValidation[] = [];
    const indexLines: string[] = [];
    for (const conversation of inventory.conversations) {
      const basePath = conversationBasePath(conversation.id);
      const validation = parseJson<ConversationValidation>(await this.options.filesystem.readText(`${basePath}/validation.json`));
      const normalized = parseJson<NormalizedConversation>(await this.options.filesystem.readText(`${basePath}/conversation.json`));
      if (validation) validations.push(validation);
      if (normalized && (journal.conversations[conversation.id]?.state === "complete" || journal.conversations[conversation.id]?.state === "unchanged")) {
        indexLines.push(jsonLine({
          id: normalized.id,
          title: normalized.title,
          sourceUrl: normalized.sourceUrl,
          createdAt: normalized.createdAt ?? null,
          updatedAt: normalized.updatedAt ?? null,
          capturedAt: normalized.capturedAt,
          messageCount: normalized.messages.length,
          workspaceIds: normalized.workspaceIds,
          rawCaptureHash: normalized.provenance.rawCaptureHash,
        }));
      }
    }

    const report = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      summary,
      inventoryFindings: journal.findings,
      conversationValidations: validations,
    };
    await this.options.filesystem.writeTextAtomic("indexes/conversations.jsonl", indexLines.join(""));
    await this.options.filesystem.writeTextAtomic("indexes/assets.jsonl", assetRecords.map(jsonLine).join(""));
    await this.options.filesystem.writeTextAtomic("reports/failures.jsonl", failures.map(jsonLine).join(""));
    await this.options.filesystem.writeTextAtomic("reports/validation.json", prettyJson(report));
    await this.options.filesystem.writeTextAtomic("reports/validation.md", renderValidationReport(summary, validations, journal.findings));

    const updatedArchive: ArchiveManifest = {
      ...archive,
      updatedAt: this.now().toISOString(),
      latestRunId: journal.runId,
      conversationCount: inventory.conversations.length,
      completeConversationCount: completeCount,
      missingRemoteConversationIds,
    };
    await this.options.filesystem.writeTextAtomic("archive.json", prettyJson(updatedArchive));
    return summary;
  }

  private async loadOrCreateArchive(now: string): Promise<ArchiveManifest> {
    const existing = parseJson<ArchiveManifest>(await this.options.filesystem.readText("archive.json"));
    if (existing?.schemaVersion === ARCHIVE_SCHEMA_VERSION && existing.provider === "grok") return existing;
    const archive: ArchiveManifest = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      provider: "grok",
      createdAt: now,
      updatedAt: now,
      accountFingerprint: `archive-${this.idFactory()}`,
      conversationCount: 0,
      completeConversationCount: 0,
      missingRemoteConversationIds: [],
    };
    await this.options.filesystem.writeTextAtomic("archive.json", prettyJson(archive));
    return archive;
  }

  private async writeJournal(): Promise<void> {
    const journal = this.requireJournal();
    journal.updatedAt = this.now().toISOString();
    await this.options.filesystem.writeTextAtomic(`runs/${journal.runId}.json`, prettyJson(journal));
  }

  private requireJournal(): RunJournal {
    if (!this.journal) throw new Error("Capture journal is not initialized.");
    return this.journal;
  }
}

function renderValidationReport(
  summary: RunSummary,
  validations: ConversationValidation[],
  inventoryFindings: ValidationFinding[],
): string {
  const lines = [
    "# Grok export validation",
    "",
    `Run: \`${summary.runId}\``,
    "",
    `Result: **${summary.complete ? "COMPLETE" : "INCOMPLETE"}**`,
    "",
    `- Inventory conversations: ${summary.inventoryCount}`,
    `- Complete conversations: ${summary.completeCount}`,
    `- Unchanged conversations: ${summary.unchangedCount}`,
    `- Failed conversations: ${summary.failedCount}`,
    `- Failed or unresolved assets: ${summary.assetFailureCount}`,
    `- Previously archived but absent remotely: ${summary.missingRemoteConversationIds.length}`,
    "",
  ];
  const findings = [...inventoryFindings, ...validations.flatMap((validation) => validation.findings)];
  if (findings.length) {
    lines.push("## Findings", "");
    for (const finding of findings) lines.push(`- **${finding.severity.toUpperCase()} · ${finding.code}:** ${finding.message}`);
    lines.push("");
  }
  if (summary.failures.length) {
    lines.push("## Failures", "");
    for (const failure of summary.failures) lines.push(`- \`${failure.conversationId}\`: ${failure.error.message}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
