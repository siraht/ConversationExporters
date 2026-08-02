import type { ArchiveFileSystem } from "../core/filesystem";
import { extensionFromMediaType, safePathSegment } from "../core/paths";
import { IncrementalSha256 } from "../core/sha256-stream";
import type { AssetRecord, ConversationAssetIndex, InventoryConversation, InventoryProject, JsonValue, ProjectAssetIndex, SafeFailure } from "../core/types";
import { decodeBase64, MAX_ASSET_CHUNK_BYTES } from "./asset-session";
import type { ChatGptTransport, DiscoveredWorkspace } from "./client";
import type { ChatGptConversationDetail } from "./envelopes";

interface DiscoveredAsset {
  logicalId: string;
  providerId: string | null;
  sourceMessageId: string | null;
  kind: AssetRecord["kind"];
  originalName: string | null;
  mediaType: string | null;
  rawDescriptor: JsonValue;
  inlineBytes?: Uint8Array;
}

export interface AssetCaptureSettings {
  maxFileBytes: number;
  maxConversationBytes: number;
  chunkBytes: number;
}

export const DEFAULT_ASSET_SETTINGS: AssetCaptureSettings = {
  maxFileBytes: 2_000_000_000,
  maxConversationBytes: 5_000_000_000,
  chunkBytes: MAX_ASSET_CHUNK_BYTES,
};

export class ChatGptAssetManager {
  private readonly downloaded = new Map<string, { sha256: string; path: string; byteSize: number; mediaType: string | null }>();

  constructor(private readonly options: {
    transport: ChatGptTransport;
    filesystem: ArchiveFileSystem;
    workspace: DiscoveredWorkspace;
    settings?: AssetCaptureSettings;
  }) {
    const settings = options.settings ?? DEFAULT_ASSET_SETTINGS;
    if (!Number.isInteger(settings.chunkBytes) || settings.chunkBytes < 1 || settings.chunkBytes > MAX_ASSET_CHUNK_BYTES) throw new Error("Asset chunk size is invalid.");
  }

  async capture(detail: ChatGptConversationDetail, inventory: InventoryConversation): Promise<ConversationAssetIndex> {
    const descriptors = discoverAssets(detail);
    const assets = await this.captureDescriptors(descriptors, { conversationId: inventory.conversationId, projectId: null });
    return {
      schemaVersion: 1,
      conversationId: inventory.conversationId,
      status: assets.some((asset) => asset.status === "failed") ? "partial" : "complete",
      assets,
    };
  }

  async captureProject(project: InventoryProject): Promise<ProjectAssetIndex> {
    const descriptors: DiscoveredAsset[] = project.files.map((file) => ({
      logicalId: file.logicalId,
      providerId: file.providerId,
      sourceMessageId: null,
      kind: "upload",
      originalName: file.originalName,
      mediaType: file.mediaType,
      rawDescriptor: redactValue(file.rawDescriptor),
    }));
    const assets = await this.captureDescriptors(descriptors, { conversationId: null, projectId: project.projectId });
    return {
      schemaVersion: 1,
      projectId: project.projectId,
      status: assets.some((asset) => asset.status === "failed") ? "partial" : "complete",
      assets,
    };
  }

  private async captureDescriptors(
    descriptors: DiscoveredAsset[],
    context: { conversationId: string | null; projectId: string | null },
  ): Promise<AssetRecord[]> {
    const assets: AssetRecord[] = [];
    let aggregateBytes = 0;
    for (const descriptor of descriptors) {
      try {
        const cacheKey = descriptor.inlineBytes
          ? null
          : `${descriptor.providerId ?? ""}\0${context.conversationId ?? ""}\0${context.projectId ?? ""}`;
        let physical = cacheKey ? this.downloaded.get(cacheKey) : undefined;
        if (!physical) {
          physical = descriptor.inlineBytes
            ? await this.persistChunks(descriptor, oneChunk(descriptor.inlineBytes))
            : await this.downloadRemote(descriptor, context);
          if (cacheKey) this.downloaded.set(cacheKey, physical);
        }
        aggregateBytes += physical.byteSize;
        if (aggregateBytes > this.settings().maxConversationBytes) throw new AssetCaptureError("ASSET_SCOPE_LIMIT", "Conversation or project assets exceeded the configured byte limit.");
        assets.push({
          logicalId: descriptor.logicalId,
          providerId: descriptor.providerId,
          sourceMessageId: descriptor.sourceMessageId,
          kind: descriptor.kind,
          originalName: descriptor.originalName,
          safeName: descriptor.originalName === null ? null : safePathSegment(descriptor.originalName),
          mediaType: physical.mediaType,
          byteSize: physical.byteSize,
          sha256: physical.sha256,
          relativePath: `../../${physical.path}`,
          adapter: descriptor.inlineBytes ? "inline" : "chatgpt-file-download",
          status: "complete",
          rawDescriptor: descriptor.rawDescriptor,
        });
      } catch (error) {
        assets.push({
          logicalId: descriptor.logicalId,
          providerId: descriptor.providerId,
          sourceMessageId: descriptor.sourceMessageId,
          kind: descriptor.kind,
          originalName: descriptor.originalName,
          safeName: descriptor.originalName === null ? null : safePathSegment(descriptor.originalName),
          mediaType: descriptor.mediaType,
          byteSize: null,
          sha256: null,
          relativePath: null,
          adapter: descriptor.inlineBytes ? "inline" : "chatgpt-file-download",
          status: "failed",
          failure: safeFailure(error),
          rawDescriptor: descriptor.rawDescriptor,
        });
      }
    }
    return assets;
  }

  private async downloadRemote(descriptor: DiscoveredAsset, context: { conversationId: string | null; projectId: string | null }) {
    if (!descriptor.providerId) throw new AssetCaptureError("ASSET_PROVIDER_ID_MISSING", "Asset has no provider file identifier.");
    const response = await this.options.transport.request({
      operation: "asset_open",
      parameters: {
        fileId: descriptor.providerId,
        conversationId: context.conversationId,
        projectId: context.projectId,
      },
    }, this.options.workspace.accountId, 120_000);
    const opened = requireObject(response.body, "asset open response");
    const handleId = requiredString(opened.handleId, "asset handleId");
    const expectedBytes = optionalNonNegativeInteger(opened.expectedBytes);
    if (expectedBytes !== null && expectedBytes > this.settings().maxFileBytes) {
      await this.close(handleId);
      throw new AssetCaptureError("ASSET_FILE_LIMIT", "Asset exceeds the configured file byte limit.");
    }
    const mediaType = optionalString(opened.mediaType) ?? descriptor.mediaType;
    try {
      const persisted = await this.persistChunks({ ...descriptor, mediaType }, this.remoteChunks(handleId));
      if (expectedBytes !== null && persisted.byteSize !== expectedBytes) {
        throw new AssetCaptureError("ASSET_TOTAL_MISMATCH", "Asset byte count did not match the signed download descriptor.");
      }
      return persisted;
    } finally {
      await this.close(handleId);
    }
  }

  private async *remoteChunks(handleId: string): AsyncIterable<Uint8Array> {
    let offset = 0;
    let total = 0;
    while (true) {
      const response = await this.options.transport.request({
        operation: "asset_chunk",
        parameters: { handleId, offset, length: this.settings().chunkBytes },
      }, this.options.workspace.accountId, 120_000);
      const body = requireObject(response.body, "asset chunk response");
      if (requiredString(body.handleId, "asset chunk handleId") !== handleId) throw new AssetCaptureError("ASSET_HANDLE_MISMATCH", "Asset chunk returned a different handle.");
      if (optionalNonNegativeInteger(body.offset) !== offset) throw new AssetCaptureError("ASSET_OFFSET_MISMATCH", "Asset chunk returned a different offset.");
      const bytes = decodeBase64(requiredString(body.dataBase64, "asset chunk data"));
      if (bytes.byteLength !== optionalNonNegativeInteger(body.byteLength)) throw new AssetCaptureError("ASSET_LENGTH_MISMATCH", "Asset chunk byte count did not match its payload.");
      if (bytes.byteLength === 0 && body.eof !== true) throw new AssetCaptureError("ASSET_OFFSET_STALL", "Asset download returned an empty non-terminal chunk.");
      total += bytes.byteLength;
      if (total > this.settings().maxFileBytes) throw new AssetCaptureError("ASSET_FILE_LIMIT", "Asset exceeded the configured file byte limit.");
      yield bytes;
      offset += bytes.byteLength;
      if (body.eof === true) return;
      if (optionalNonNegativeInteger(body.nextOffset) !== offset) throw new AssetCaptureError("ASSET_OFFSET_MISMATCH", "Asset next offset did not advance correctly.");
    }
  }

  private async persistChunks(descriptor: DiscoveredAsset, chunks: AsyncIterable<Uint8Array>) {
    const stagingPath = `staging/assets/${crypto.randomUUID()}.part`;
    const hash = new IncrementalSha256();
    let byteSize = 0;
    let prefix = new Uint8Array();
    async function* hashing(): AsyncIterable<Uint8Array> {
      for await (const chunk of chunks) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        if (prefix.byteLength < 32) {
          const next = new Uint8Array(Math.min(32, prefix.byteLength + chunk.byteLength));
          next.set(prefix);
          next.set(chunk.subarray(0, next.byteLength - prefix.byteLength), prefix.byteLength);
          prefix = next;
        }
        yield chunk;
      }
    }
    try {
      await this.options.filesystem.writeByteChunksAtomic(stagingPath, hashing());
      const sha256 = hash.digestHex();
      const extension = extensionFromMediaType(descriptor.mediaType, prefix);
      const finalPath = `assets/${sha256}.${extension}`;
      if (!await this.options.filesystem.exists(finalPath)) {
        await this.options.filesystem.writeByteChunksAtomic(finalPath, this.options.filesystem.readByteChunks(stagingPath));
      }
      const verified = await hashFile(this.options.filesystem, finalPath);
      if (verified.sha256 !== sha256 || verified.byteSize !== byteSize) throw new AssetCaptureError("ASSET_FINAL_HASH_MISMATCH", "Content-addressed asset verification failed.");
      return { sha256, path: finalPath, byteSize, mediaType: descriptor.mediaType };
    } finally {
      if (await this.options.filesystem.exists(stagingPath)) await this.options.filesystem.remove(stagingPath);
    }
  }

  private async close(handleId: string): Promise<void> {
    await this.options.transport.request({ operation: "asset_close", parameters: { handleId } }, this.options.workspace.accountId).catch(() => undefined);
  }

  private settings(): AssetCaptureSettings {
    return this.options.settings ?? DEFAULT_ASSET_SETTINGS;
  }
}

export function discoverAssets(detail: ChatGptConversationDetail): DiscoveredAsset[] {
  const output: DiscoveredAsset[] = [];
  for (const node of Object.values(detail.mapping)) {
    if (!node.message) continue;
    visit(node.message.content as unknown as JsonValue, `message-${node.message.id}-content`, node.message.id, output);
    visit((node.message.metadata ?? {}) as unknown as JsonValue, `message-${node.message.id}-metadata`, node.message.id, output);
  }
  return output.filter((asset, index) => output.findIndex((candidate) => candidate.logicalId === asset.logicalId) === index);
}

export class AssetCaptureError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AssetCaptureError";
  }
}

async function hashFile(filesystem: ArchiveFileSystem, path: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = new IncrementalSha256();
  let byteSize = 0;
  for await (const chunk of filesystem.readByteChunks(path)) {
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  return { sha256: hash.digestHex(), byteSize };
}

function visit(value: JsonValue, path: string, messageId: string, output: DiscoveredAsset[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => visit(child, `${path}-${index}`, messageId, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, JsonValue>;
  const contentType = optionalString(object.content_type) ?? optionalString(object.type) ?? "";
  const rawPointer = optionalString(object.asset_pointer) ?? optionalString(object.file_id);
  const dataUrl = rawPointer?.startsWith("data:") ? parseDataUrl(rawPointer) : null;
  const providerId = dataUrl ? null : providerIdFromPointer(rawPointer);
  if (providerId || dataUrl) {
    output.push({
      logicalId: `${path}-${providerId ?? "inline"}`,
      providerId,
      sourceMessageId: messageId,
      kind: assetKind(contentType),
      originalName: optionalString(object.name) ?? optionalString(object.filename),
      mediaType: dataUrl?.mediaType ?? optionalString(object.mime_type) ?? optionalString(object.mimeType),
      rawDescriptor: redactDescriptor(object),
      ...(dataUrl === null ? {} : { inlineBytes: dataUrl.bytes }),
    });
  }
  if (["canvas", "textdoc", "code_edit"].includes(contentType)) {
    const text = optionalString(object.text) ?? optionalString(object.content);
    if (text !== null) output.push({
      logicalId: `${path}-canvas`, providerId: null, sourceMessageId: messageId, kind: "canvas",
      originalName: optionalString(object.name), mediaType: "text/plain", rawDescriptor: redactDescriptor(object),
      inlineBytes: new TextEncoder().encode(text),
    });
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === "asset_pointer" && typeof child === "string") continue;
    visit(child, `${path}-${safePathSegment(key, "field", 60)}`, messageId, output);
  }
}

function providerIdFromPointer(value: string | null): string | null {
  if (!value) return null;
  const stripped = value.replace(/^(?:sediment|file-service):\/\//, "");
  return /^[A-Za-z0-9_-]{1,256}$/.test(stripped) ? stripped : null;
}

function parseDataUrl(value: string): { mediaType: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) return null;
  try {
    const mediaType = match[1] || "application/octet-stream";
    const bytes = match[2] ? decodeBase64(match[3]!) : new TextEncoder().encode(decodeURIComponent(match[3]!));
    return { mediaType, bytes };
  } catch {
    return null;
  }
}

function redactDescriptor(value: Record<string, JsonValue>): JsonValue {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return `[inline data omitted: ${value.length} characters]`;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        url.search = "";
        url.hash = "";
        return url.toString();
      }
    } catch {
      // Ordinary strings remain unchanged.
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  return value;
}

function assetKind(contentType: string): AssetRecord["kind"] {
  if (contentType.includes("image")) return "generated_image";
  if (contentType.includes("audio")) return "audio";
  if (contentType.includes("video")) return "video";
  if (contentType.includes("canvas") || contentType.includes("textdoc")) return "canvas";
  if (contentType.includes("research")) return "research";
  if (contentType.includes("file")) return "upload";
  return "unknown";
}

function requireObject(value: JsonValue, name: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssetCaptureError("ASSET_RESPONSE_INVALID", `${name} must be an object.`);
  return value;
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value) throw new AssetCaptureError("ASSET_RESPONSE_INVALID", `${name} must be a non-empty string.`);
  return value;
}

function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNonNegativeInteger(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeFailure(error: unknown): SafeFailure {
  const candidate = error as { code?: unknown; retryable?: unknown; correlationId?: unknown } | null;
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "ASSET_CAPTURE_FAILED",
    message: error instanceof Error ? error.message : "Asset capture failed.",
    retryable: candidate?.retryable === true,
    correlationId: typeof candidate?.correlationId === "string" ? candidate.correlationId : crypto.randomUUID(),
  };
}

async function* oneChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}
