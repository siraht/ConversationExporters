import { sanitizeError } from "./errors";
import type { ArchiveFileSystem } from "./filesystem";
import { sha256Hex } from "./hash";
import { extensionFromMediaType, safePathSegment } from "./paths";
import type {
  AssetDownloadRecord,
  CancellationSignal,
  NormalizedAttachment,
  NormalizedConversation,
  ProgressEvent,
  ValidationFinding,
} from "./types";

export interface AssetFetchResult {
  bytes: Uint8Array;
  mediaType?: string;
  finalUrl: string;
}

export interface AssetFetcher {
  fetch(url: string, cancellation?: CancellationSignal): Promise<AssetFetchResult>;
}

export interface AssetDownloadResult {
  status: "complete" | "partial" | "not_requested";
  records: AssetDownloadRecord[];
  findings: ValidationFinding[];
}

export interface DownloadAssetsOptions {
  conversation: NormalizedConversation;
  basePath: string;
  filesystem: ArchiveFileSystem;
  fetcher?: AssetFetcher;
  resolve?: (attachment: NormalizedAttachment) => Promise<string | undefined>;
  cancellation?: CancellationSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export async function downloadConversationAssets(options: DownloadAssetsOptions): Promise<AssetDownloadResult> {
  const attachments = options.conversation.messages.flatMap((message) =>
    message.attachments.map((attachment) => ({ message, attachment })),
  );
  if (!options.fetcher) return { status: "not_requested", records: [], findings: [] };

  const records: AssetDownloadRecord[] = [];
  const findings: ValidationFinding[] = [];
  const completedByUrl = new Map<string, AssetDownloadRecord>();

  for (let index = 0; index < attachments.length; index += 1) {
    await options.cancellation?.waitIfPaused?.();
    options.cancellation?.throwIfCancelled();
    const { message, attachment } = attachments[index]!;
    options.onProgress?.({
      phase: "asset",
      message: `Downloading asset ${index + 1} of ${attachments.length}`,
      completed: index,
      total: attachments.length,
      conversationId: options.conversation.id,
    });
    let sourceUrl = attachment.sourceUrl;
    if (!sourceUrl) sourceUrl = await options.resolve?.(attachment);
    if (!sourceUrl) {
      const record: AssetDownloadRecord = {
        conversationId: options.conversation.id,
        messageId: message.id,
        status: "missing_url",
        ...(attachment.id === undefined ? {} : { attachmentId: attachment.id }),
      };
      records.push(record);
      findings.push(assetFinding("ASSET_URL_MISSING", "Attachment has no downloadable URL.", options.conversation.id, message.id, attachment.id));
      continue;
    }

    const duplicate = completedByUrl.get(sourceUrl);
    if (duplicate?.status === "complete" && duplicate.localPath && duplicate.contentHash) {
      attachment.localPath = duplicate.localPath.replace(`${options.basePath}/`, "");
      attachment.contentHash = duplicate.contentHash;
      if (duplicate.size !== undefined) attachment.size = duplicate.size;
      if (duplicate.mediaType !== undefined) attachment.mediaType = duplicate.mediaType;
      records.push({ ...duplicate, messageId: message.id, ...(attachment.id === undefined ? {} : { attachmentId: attachment.id }) });
      continue;
    }

    try {
      let fetched: AssetFetchResult;
      try {
        fetched = await options.fetcher.fetch(sourceUrl, options.cancellation);
      } catch (firstError) {
        const resolved = await options.resolve?.(attachment);
        if (!resolved || resolved === sourceUrl) throw firstError;
        sourceUrl = resolved;
        fetched = await options.fetcher.fetch(sourceUrl, options.cancellation);
      }
      const contentHash = await sha256Hex(fetched.bytes);
      const extension = chooseExtension(fetched.mediaType ?? attachment.mediaType, fetched.finalUrl);
      const filename = `${contentHash}.${extension}`;
      const archivePath = `${options.basePath}/assets/${filename}`;
      await options.filesystem.writeBytesAtomic(archivePath, fetched.bytes);
      attachment.localPath = `assets/${filename}`;
      attachment.contentHash = contentHash;
      attachment.size = fetched.bytes.byteLength;
      if (fetched.mediaType) attachment.mediaType = fetched.mediaType;
      const record: AssetDownloadRecord = {
        conversationId: options.conversation.id,
        messageId: message.id,
        sourceUrl,
        finalUrl: fetched.finalUrl,
        localPath: archivePath,
        contentHash,
        size: fetched.bytes.byteLength,
        status: "complete",
        ...(attachment.id === undefined ? {} : { attachmentId: attachment.id }),
        ...(fetched.mediaType === undefined ? {} : { mediaType: fetched.mediaType }),
      };
      records.push(record);
      completedByUrl.set(sourceUrl, record);
    } catch (error) {
      const sanitized = sanitizeError(error);
      records.push({
        conversationId: options.conversation.id,
        messageId: message.id,
        sourceUrl,
        status: "failed",
        error: sanitized,
        ...(attachment.id === undefined ? {} : { attachmentId: attachment.id }),
      });
      findings.push(assetFinding("ASSET_DOWNLOAD_FAILED", sanitized.message, options.conversation.id, message.id, attachment.id));
    }
  }

  return {
    status: records.some((record) => record.status !== "complete") ? "partial" : "complete",
    records,
    findings,
  };
}

function chooseExtension(mediaType: string | undefined, url: string): string {
  if (mediaType) return extensionFromMediaType(mediaType);
  try {
    const pathname = new URL(url).pathname;
    const extension = pathname.split(".").at(-1)?.toLowerCase();
    if (extension && /^[a-z0-9]{1,10}$/.test(extension)) return safePathSegment(extension, "bin", 10);
  } catch {
    // Fall through to a neutral binary extension.
  }
  return "bin";
}

function assetFinding(
  code: string,
  message: string,
  conversationId: string,
  responseId: string,
  assetId: string | undefined,
): ValidationFinding {
  return {
    code,
    severity: "warning",
    message,
    conversationId,
    responseId,
    ...(assetId === undefined ? {} : { assetId }),
  };
}

