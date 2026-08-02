import type { ArchiveFileSystem } from "./filesystem";
import { sha256Hex } from "./hash";
import { conversationBasePath, safePathSegment } from "./paths";
import { parseJson, prettyJson } from "./serialization";
import type { CaptureJournalEntry, CaptureStage, InventoryConversation, JsonValue, SafeFailure } from "./types";

export interface RunJournal {
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  createdAt: string;
  updatedAt: string;
  entries: CaptureJournalEntry[];
}

export interface RawCompletionMarker {
  schemaVersion: 1;
  provider: "chatgpt-web";
  logicalKey: string;
  conversationId: string;
  workspaceFingerprint: string;
  listingHashes: string[];
  detailHash: string;
  detailPath: string;
  batchHash: string | null;
  batchPath: string | null;
  retrievalSource: "batch" | "single" | "shared";
  completedAt: string;
}

const ALLOWED_TRANSITIONS: Record<CaptureStage, CaptureStage[]> = {
  pending: ["capturing", "failed"],
  capturing: ["writing", "failed"],
  writing: ["complete", "failed"],
  complete: [],
  failed: ["capturing"],
};

export class CaptureStore {
  private journal: RunJournal | undefined;

  constructor(
    private readonly filesystem: ArchiveFileSystem,
    private readonly runId: string,
    private readonly workspaceFingerprint: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error("runId is invalid");
  }

  async start(): Promise<RunJournal> {
    const existing = parseJson<RunJournal>(await this.filesystem.readText(this.journalPath()));
    if (existing) {
      if (existing.runId !== this.runId || existing.workspaceFingerprint !== this.workspaceFingerprint) throw new Error("Run journal identity mismatch.");
      this.journal = existing;
      return existing;
    }
    const timestamp = this.now().toISOString();
    this.journal = { schemaVersion: 1, runId: this.runId, workspaceFingerprint: this.workspaceFingerprint, createdAt: timestamp, updatedAt: timestamp, entries: [] };
    await this.persistJournal();
    return this.journal;
  }

  async transition(
    conversation: InventoryConversation,
    to: CaptureStage,
    details: { attempt: number; correlationId: string; rawHash?: string; completionHash?: string; error?: SafeFailure },
  ): Promise<CaptureJournalEntry> {
    const journal = await this.requireJournal();
    const previous = [...journal.entries].reverse().find((entry) => entry.logicalKey === conversation.logicalKey);
    const from = previous?.to ?? null;
    if (from === null) {
      if (to !== "pending" && to !== "complete") throw new Error(`Initial transition to ${to} is invalid.`);
    } else if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new Error(`Invalid capture transition ${from} -> ${to}.`);
    }
    const entry: CaptureJournalEntry = {
      sequence: journal.entries.length + 1,
      logicalKey: conversation.logicalKey,
      conversationId: conversation.conversationId,
      from,
      to,
      occurredAt: this.now().toISOString(),
      runId: this.runId,
      attempt: details.attempt,
      correlationId: details.correlationId,
      ...(details.rawHash === undefined ? {} : { rawHash: details.rawHash }),
      ...(details.completionHash === undefined ? {} : { completionHash: details.completionHash }),
      ...(details.error === undefined ? {} : { error: details.error }),
    };
    journal.entries.push(entry);
    journal.updatedAt = entry.occurredAt;
    await this.persistJournal();
    return entry;
  }

  async writeRawRevision(conversationId: string, kind: "listing" | "detail" | "batch", value: JsonValue): Promise<{ hash: string; path: string }> {
    const content = prettyJson(value);
    const hash = await sha256Hex(content);
    const path = `${conversationBasePath(conversationId)}/source/${kind}-${hash}.json`;
    const existing = await this.filesystem.readText(path);
    if (existing !== undefined && await sha256Hex(existing) !== hash) throw new Error(`Existing raw revision hash mismatch at ${path}.`);
    if (existing === undefined) await this.filesystem.writeTextAtomic(path, content);
    return { hash, path };
  }

  async writeRawMarker(marker: RawCompletionMarker): Promise<string> {
    const content = prettyJson(marker);
    const hash = await sha256Hex(content);
    await this.filesystem.writeTextAtomic(`${conversationBasePath(marker.conversationId)}/raw-complete.json`, content);
    return hash;
  }

  async validRawMarker(conversation: InventoryConversation): Promise<RawCompletionMarker | undefined> {
    const path = `${conversationBasePath(conversation.conversationId)}/raw-complete.json`;
    const marker = parseJson<RawCompletionMarker>(await this.filesystem.readText(path));
    if (!marker
      || marker.schemaVersion !== 1
      || marker.provider !== "chatgpt-web"
      || marker.logicalKey !== conversation.logicalKey
      || marker.conversationId !== conversation.conversationId
      || marker.workspaceFingerprint !== this.workspaceFingerprint
      || !sameSet(marker.listingHashes, conversation.listingHashes)) return undefined;
    const detail = await this.filesystem.readText(marker.detailPath);
    if (detail === undefined || await sha256Hex(detail) !== marker.detailHash) return undefined;
    if ((marker.batchHash === null) !== (marker.batchPath === null)) return undefined;
    if (marker.batchHash && marker.batchPath) {
      const batch = await this.filesystem.readText(marker.batchPath);
      if (batch === undefined || await sha256Hex(batch) !== marker.batchHash) return undefined;
    }
    return marker;
  }

  async writeDerivedText(conversationId: string, name: "conversation.json" | "conversation.md" | "complete.json" | "metadata.json" | "assets.json", content: string): Promise<void> {
    await this.filesystem.writeTextAtomic(`${conversationBasePath(conversationId)}/${name}`, content);
  }

  private async requireJournal(): Promise<RunJournal> {
    return this.journal ?? this.start();
  }

  private journalPath(): string {
    return `runs/${safePathSegment(this.runId, "run", 128)}.json`;
  }

  private async persistJournal(): Promise<void> {
    if (!this.journal) throw new Error("Run journal is not initialized.");
    await this.filesystem.writeTextAtomic(this.journalPath(), prettyJson(this.journal));
  }
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
