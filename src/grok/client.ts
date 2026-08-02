import { GrokExporterError } from "../core/errors";
import { hashJson } from "../core/hash";
import { firstString, isJsonObject } from "../core/json";
import { RequestPacer, isRetryableHttpStatus, withRetry } from "../core/retry";
import {
  ARCHIVE_SCHEMA_VERSION,
  type ApiSuccessResponse,
  type ApiTransport,
  type CancellationSignal,
  type CaptureSettings,
  type ConversationListEntry,
  type ConversationInventory,
  type JsonObject,
  type JsonValue,
  type ProgressEvent,
  type RawConversationCapture,
  type RawResponseBatch,
  type SupportingCollectionCapture,
  type SupportingMetadataCapture,
  type ValidationFinding,
} from "../core/types";
import {
  collectResponseIds,
  assetsFromEnvelope,
  conversationListFromEnvelope,
  nextPageTokenFromEnvelope,
  nextResponseCursorFromEnvelope,
  normalizeListEntry,
  responseEnvelopeHasMore,
  responseNodesFromEnvelope,
  responsesFromEnvelope,
  workspacesFromEnvelope,
} from "./envelopes";
import {
  conversationListPath,
  conversationMetadataPath,
  loadResponsesPath,
  responseNodesPath,
  assetsListPath,
  workspacesListPath,
  workspaceDetailPath,
  assetPath,
} from "./endpoints";

export interface GrokClientOptions {
  transport: ApiTransport;
  settings: CaptureSettings;
  cancellation?: CancellationSignal;
  onProgress?: (event: ProgressEvent) => void;
  now?: () => Date;
}

export class GrokClient {
  private readonly pacer: RequestPacer;
  private readonly now: () => Date;
  private workspaceInventory?: SupportingCollectionCapture;

  constructor(private readonly options: GrokClientOptions) {
    this.pacer = new RequestPacer(options.settings.requestDelayMs);
    this.now = options.now ?? (() => new Date());
  }

  async inventory(): Promise<ConversationInventory> {
    const capturedAt = this.now().toISOString();
    const pages: ConversationInventory["pages"] = [];
    const conversations: ConversationInventory["conversations"] = [];
    const warnings: ValidationFinding[] = [];
    const conversationsById = new Map<string, ConversationListEntry>();
    let aggregateBytes = 0;

    const mergeEntry = async (entry: ConversationListEntry, workspaceId?: string): Promise<void> => {
      const existing = conversationsById.get(entry.id);
      const workspaceIds = [...new Set([
        ...(existing?.workspaceIds ?? []),
        ...entry.workspaceIds,
        ...(workspaceId === undefined ? [] : [workspaceId]),
      ])];
      if (existing) {
        if (workspaceIds.length !== existing.workspaceIds.length) {
          existing.workspaceIds = workspaceIds;
          existing.listingHash = await hashJson({
            listing: existing.raw,
            discoveredWorkspaceIds: workspaceIds,
          });
        }
        return;
      }
      if (workspaceIds.length !== entry.workspaceIds.length) {
        entry.workspaceIds = workspaceIds;
        entry.listingHash = await hashJson({ listing: entry.raw, discoveredWorkspaceIds: workspaceIds });
      }
      conversationsById.set(entry.id, entry);
      conversations.push(entry);
    };

    const captureScope = async (workspaceId?: string): Promise<void> => {
      const seenIds = new Set<string>();
      const seenTokens = new Set<string>();
      let pageToken: string | undefined;

      for (let pageNumber = 1; pageNumber <= this.options.settings.maxPages; pageNumber += 1) {
        this.options.cancellation?.throwIfCancelled();
        this.options.onProgress?.({
          phase: "inventory",
          message: `Loading ${workspaceId === undefined ? "history" : "workspace history"} page ${pageNumber}`,
        });

        const response = await this.request(
          conversationListPath(this.options.settings.pageSize, pageToken, workspaceId),
          "GET",
        );
        aggregateBytes += response.responseBytes;
        if (aggregateBytes > this.options.settings.maxResponseBytes) {
          throw new GrokExporterError("Conversation inventory exceeded the configured byte limit.", {
            code: "INVENTORY_BYTE_LIMIT",
          });
        }

        const rawItems = conversationListFromEnvelope(response.body);
        const nextPageToken = nextPageTokenFromEnvelope(response.body);
        pages.push({
          pageNumber,
          itemCount: rawItems.length,
          responseBytes: response.responseBytes,
          responseHash: await hashJson(response.body),
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(pageToken === undefined ? {} : { requestedPageToken: pageToken }),
          ...(nextPageToken === undefined ? {} : { returnedPageToken: nextPageToken }),
        });

        if (rawItems.length === 0 && nextPageToken) {
          warnings.push({
            code: "EMPTY_INVENTORY_PAGE",
            severity: "warning",
            message: `Inventory page ${pageNumber} was empty but supplied another page token.`,
            details: { pageNumber, ...(workspaceId === undefined ? {} : { workspaceId }) },
          });
        }

        for (const rawItem of rawItems) {
          const entry = await normalizeListEntry(rawItem);
          if (!entry) {
            warnings.push({
              code: "CONVERSATION_ID_MISSING",
              severity: "error",
              message: `An item on inventory page ${pageNumber} had no recognized conversation ID.`,
              details: { pageNumber, ...(workspaceId === undefined ? {} : { workspaceId }) },
            });
            continue;
          }
          if (seenIds.has(entry.id)) {
            warnings.push({
              code: "CONVERSATION_ID_DUPLICATE",
              severity: "warning",
              message: `Conversation ${entry.id} appeared more than once in one inventory scope.`,
              conversationId: entry.id,
            });
            continue;
          }
          seenIds.add(entry.id);
          await mergeEntry(entry, workspaceId);
        }

        this.options.onProgress?.({
          phase: "inventory",
          message: `Discovered ${conversations.length} conversations`,
          completed: conversations.length,
        });

        if (!nextPageToken) return;
        if (seenTokens.has(nextPageToken) || nextPageToken === pageToken) {
          throw new GrokExporterError("Grok returned a repeated conversation page token.", {
            code: "INVENTORY_TOKEN_CYCLE",
          });
        }
        seenTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }

      throw new GrokExporterError("Conversation inventory hit the configured page limit before token exhaustion.", {
        code: "INVENTORY_PAGE_LIMIT",
      });
    };

    await captureScope();
    if (this.options.settings.includeWorkspaces) {
      this.workspaceInventory = await this.captureSupportingCollection("workspaces", workspacesListPath, workspacesFromEnvelope);
      warnings.push(...this.workspaceInventory.findings);
      for (const workspace of this.workspaceInventory.items) {
        const workspaceId = typeof workspace === "string"
          ? workspace
          : firstString(workspace, [["workspaceId"], ["id"], ["uuid"]]);
        if (!workspaceId) {
          warnings.push({
            code: "WORKSPACE_ID_MISSING",
            severity: "error",
            message: "A workspace record had no recognized identifier, so its conversation scope could not be inventoried.",
          });
          continue;
        }
        await captureScope(workspaceId);
      }
    }

    return {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      provider: "grok",
      capturedAt,
      completedAt: this.now().toISOString(),
      complete: !warnings.some((warning) => warning.severity === "error"),
      pageSize: this.options.settings.pageSize,
      pages,
      conversations,
      warnings,
    };
  }

  async captureConversation(
    listingEntry: JsonObject,
    discoveredWorkspaceIds: string[] = [],
  ): Promise<{ capture: RawConversationCapture; findings: ValidationFinding[] }> {
    const normalized = await normalizeListEntry(listingEntry);
    if (!normalized) throw new GrokExporterError("Cannot capture a conversation without an ID.", { code: "CONVERSATION_ID_MISSING" });
    const conversationId = normalized.id;
    const capturedAt = this.now().toISOString();

    this.options.onProgress?.({ phase: "capture", message: `Capturing ${normalized.title}`, conversationId });
    const [metadataResponse, nodesResponse] = await Promise.all([
      this.request(conversationMetadataPath(conversationId), "GET"),
      this.request(responseNodesPath(conversationId), "GET"),
    ]);

    const nodes = responseNodesFromEnvelope(nodesResponse.body);
    const { ids: responseIds, findings } = collectResponseIds(nodes);
    const responseBatches: RawResponseBatch[] = [];

    for (let offset = 0; offset < responseIds.length; offset += this.options.settings.responseBatchSize) {
      const requestedIds = responseIds.slice(offset, offset + this.options.settings.responseBatchSize);
      const batches = await this.loadResponseBatch(conversationId, requestedIds, responseBatches.length + 1);
      responseBatches.push(...batches);
    }

    return {
      capture: {
        provider: "grok",
        capturedAt,
        listingEntry,
        ...(discoveredWorkspaceIds.length === 0
          ? {}
          : { discoveredWorkspaceIds: [...new Set(discoveredWorkspaceIds)] }),
        metadata: metadataResponse.body,
        responseNodes: nodesResponse.body,
        responseBatches,
      },
      findings,
    };
  }

  async captureSupportingMetadata(): Promise<SupportingMetadataCapture> {
    const capture: SupportingMetadataCapture = {
      capturedAt: this.now().toISOString(),
      workspaceDetails: {},
    };
    if (this.options.settings.includeAssets) {
      try {
        capture.assets = await this.captureSupportingCollection("assets", assetsListPath, assetsFromEnvelope);
      } catch (error) {
        capture.assets = failedSupportingCollection("ASSET_LIBRARY_CAPTURE_FAILED", error);
      }
    }
    if (this.options.settings.includeWorkspaces) {
      try {
        capture.workspaces = this.workspaceInventory
          ?? await this.captureSupportingCollection("workspaces", workspacesListPath, workspacesFromEnvelope);
      } catch (error) {
        capture.workspaces = failedSupportingCollection("WORKSPACE_CAPTURE_FAILED", error);
      }
      for (const workspace of capture.workspaces.items) {
        const workspaceId = typeof workspace === "string"
          ? workspace
          : firstString(workspace, [["workspaceId"], ["id"], ["uuid"]]);
        if (!workspaceId) {
          capture.workspaces.findings.push({
            code: "WORKSPACE_ID_MISSING",
            severity: "warning",
            message: "A workspace record had no recognized identifier, so its detail payload could not be captured.",
          });
          continue;
        }
        try {
          capture.workspaceDetails[workspaceId] = (await this.request(workspaceDetailPath(workspaceId), "GET")).body;
        } catch (error) {
          capture.workspaceDetails[workspaceId] = {
            error: error instanceof Error ? error.message : String(error),
          };
          capture.workspaces.findings.push({
            code: "WORKSPACE_DETAIL_CAPTURE_FAILED",
            severity: "warning",
            message: `The detail payload could not be captured for workspace ${workspaceId}.`,
          });
        }
      }
    }
    return capture;
  }

  async fetchAssetRecord(assetId: string): Promise<JsonValue> {
    return (await this.request(assetPath(assetId), "GET")).body;
  }

  private async loadResponseBatch(conversationId: string, responseIds: string[], startingBatchNumber: number): Promise<RawResponseBatch[]> {
    const output: RawResponseBatch[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < this.options.settings.maxPages; page += 1) {
      const body: JsonObject = { responseIds };
      if (cursor) body.cursor = cursor;
      let response: ApiSuccessResponse;
      try {
        response = await this.request(loadResponsesPath(conversationId), "POST", body);
      } catch (error) {
        if (!(error instanceof GrokExporterError) || ![400, 422].includes(error.httpStatus ?? 0) || cursor) throw error;
        response = await this.request(loadResponsesPath(conversationId), "POST", { ids: responseIds });
      }

      const nextCursor = nextResponseCursorFromEnvelope(response.body);
      output.push({
        batchNumber: startingBatchNumber + output.length,
        requestedIds: responseIds,
        responseHash: await hashJson(response.body),
        raw: response.body,
        ...(cursor === undefined ? {} : { cursor }),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });

      const hasMore = responseEnvelopeHasMore(response.body);
      if (!nextCursor) {
        if (hasMore) {
          throw new GrokExporterError("Grok marked a response batch as incomplete without returning a cursor.", {
            code: "RESPONSE_CURSOR_MISSING",
          });
        }
        return output;
      }
      if (seenCursors.has(nextCursor) || nextCursor === cursor) {
        throw new GrokExporterError("Grok returned a repeated response cursor.", { code: "RESPONSE_CURSOR_CYCLE" });
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new GrokExporterError("Response loading hit the configured page limit.", { code: "RESPONSE_PAGE_LIMIT" });
  }

  private async captureSupportingCollection(
    label: string,
    pathBuilder: (pageSize: number, pageToken?: string) => string,
    extractItems: (value: JsonValue) => JsonValue[],
  ): Promise<SupportingCollectionCapture> {
    const pages: SupportingCollectionCapture["pages"] = [];
    const items: JsonValue[] = [];
    const findings: ValidationFinding[] = [];
    const seenTokens = new Set<string>();
    const seenItemHashes = new Set<string>();
    let pageToken: string | undefined;

    for (let pageNumber = 1; pageNumber <= this.options.settings.maxPages; pageNumber += 1) {
      this.options.onProgress?.({ phase: "capture", message: `Loading Grok ${label} page ${pageNumber}` });
      const response = await this.request(pathBuilder(this.options.settings.pageSize, pageToken), "GET");
      const pageItems = extractItems(response.body);
      const nextPageToken = nextPageTokenFromEnvelope(response.body);
      pages.push({
        pageNumber,
        itemCount: pageItems.length,
        responseHash: await hashJson(response.body),
        raw: response.body,
        ...(pageToken === undefined ? {} : { requestedPageToken: pageToken }),
        ...(nextPageToken === undefined ? {} : { returnedPageToken: nextPageToken }),
      });
      for (const item of pageItems) {
        const itemHash = await hashJson(item);
        if (seenItemHashes.has(itemHash)) continue;
        seenItemHashes.add(itemHash);
        items.push(item);
      }
      if (!nextPageToken) return { complete: true, pages, items, findings };
      if (seenTokens.has(nextPageToken) || nextPageToken === pageToken) {
        throw new GrokExporterError(`Grok returned a repeated ${label} page token.`, {
          code: "SUPPORTING_TOKEN_CYCLE",
        });
      }
      seenTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GrokExporterError(`Grok ${label} capture hit the configured page limit.`, {
      code: "SUPPORTING_PAGE_LIMIT",
    });
  }

  private async request(path: string, method: "GET" | "POST", body?: JsonValue): Promise<ApiSuccessResponse> {
    await this.pacer.wait(this.options.cancellation);
    return withRetry(async () => {
      const response = await this.options.transport.request({
        path,
        method,
        timeoutMs: 60_000,
        ...(body === undefined ? {} : { body }),
      });
      if (response.responseBytes > this.options.settings.maxResponseBytes) {
        throw new GrokExporterError(`Grok response exceeded ${this.options.settings.maxResponseBytes} bytes.`, {
          code: "RESPONSE_BYTE_LIMIT",
        });
      }
      return response;
    }, {
      maxRetries: this.options.settings.maxRetries,
      ...(this.options.cancellation === undefined ? {} : { cancellation: this.options.cancellation }),
    });
  }
}

export function apiHttpError(path: string, status: number, retryAfterMs?: number): GrokExporterError {
  return new GrokExporterError(`Grok API request failed with HTTP ${status}: ${path}`, {
    code: "GROK_HTTP_ERROR",
    httpStatus: status,
    retryable: isRetryableHttpStatus(status),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

export function assertJsonResponse(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(assertJsonResponse);
  if (isJsonObject(value)) {
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(value)) output[key] = assertJsonResponse(child);
    return output;
  }
  throw new GrokExporterError("Grok returned a non-JSON response value.", { code: "INVALID_JSON_RESPONSE" });
}

export function capturedResponses(capture: RawConversationCapture): JsonValue[] {
  return capture.responseBatches.flatMap((batch) => responsesFromEnvelope(batch.raw));
}

function failedSupportingCollection(code: string, error: unknown): SupportingCollectionCapture {
  return {
    complete: false,
    pages: [],
    items: [],
    findings: [{
      code,
      severity: "warning",
      message: error instanceof Error ? error.message : String(error),
    }],
  };
}
