import type { ArchiveFileSystem } from "./filesystem";
import { assertSafeRelativePath } from "./paths";

interface NativeReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type NativeArchiveNamespace = "chatgpt-web" | "claude-web" | "gemini-web" | "grok-web";

export class NativeArchiveFileSystem implements ArchiveFileSystem {
  private readonly port = chrome.runtime.connectNative("com.conversation_exporters.archive");
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly namespace: NativeArchiveNamespace, private readonly prefix = "") {
    if (prefix) assertSafeRelativePath(prefix);
    this.port.onMessage.addListener((value: unknown) => this.receive(value));
    this.port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? "Conversation archive native host disconnected";
      for (const pending of this.pending.values()) pending.reject(new Error(message));
      this.pending.clear();
    });
  }

  async writeTextAtomic(path: string, content: string): Promise<void> {
    await this.writeBytesAtomic(path, new TextEncoder().encode(content));
  }

  async writeBytesAtomic(path: string, content: Uint8Array): Promise<void> {
    await this.writeByteChunksAtomic(path, (async function* () { yield content; })());
  }

  async writeByteChunksAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const safePath = this.path(path);
    const writeId = crypto.randomUUID();
    await this.request("writeStart", { path: safePath, writeId });
    try {
      for await (const chunk of chunks) {
        for (let offset = 0; offset < chunk.byteLength; offset += 196_608) {
          await this.request("writeChunk", {
            writeId,
            data: bytesToBase64(chunk.subarray(offset, offset + 196_608)),
          });
        }
      }
      await this.request("writeEnd", { writeId });
    } catch (error) {
      await this.request("writeAbort", { writeId }).catch(() => undefined);
      throw error;
    }
  }

  async *readByteChunks(path: string, chunkSize = 262_144): AsyncIterable<Uint8Array> {
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 262_144) throw new Error("chunkSize must be 1-262144");
    const safePath = this.path(path);
    for (let offset = 0; ; offset += chunkSize) {
      const result = await this.request("readChunk", { path: safePath, offset, length: chunkSize });
      if (!isChunkResult(result)) throw new Error("Native archive host returned an invalid read result");
      if (result.missing) throw new DOMException("File not found", "NotFoundError");
      const bytes = base64ToBytes(result.data);
      if (bytes.byteLength) yield bytes;
      if (result.done) break;
    }
  }

  async readText(path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of this.readByteChunks(path)) {
        chunks.push(chunk);
        size += chunk.byteLength;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
      throw error;
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }

  async exists(path: string): Promise<boolean> {
    return await this.request("exists", { path: this.path(path) }) === true;
  }

  async byteSize(path: string): Promise<number | undefined> {
    const result = await this.request("size", { path: this.path(path) });
    if (result === null) return undefined;
    if (!Number.isSafeInteger(result) || Number(result) < 0) throw new Error("Native archive host returned an invalid file size");
    return Number(result);
  }

  async listPaths(prefix = ""): Promise<string[]> {
    if (prefix) assertSafeRelativePath(prefix);
    const result = await this.request("list", { prefix: this.path(prefix, true) });
    if (!Array.isArray(result) || !result.every((value) => typeof value === "string")) throw new Error("Native archive host returned an invalid path list");
    const base = this.prefix ? `${this.prefix}/` : "";
    return result.map((value) => value.startsWith(base) ? value.slice(base.length) : value).sort();
  }

  async remove(path: string): Promise<void> {
    await this.request("remove", { path: this.path(path) });
  }

  async ready(): Promise<void> {
    await this.request("list", { prefix: this.path("", true) });
  }

  private path(path: string, allowEmpty = false): string {
    if (path) assertSafeRelativePath(path);
    else if (!allowEmpty) throw new Error("Archive path is empty");
    return [this.prefix, path].filter(Boolean).join("/");
  }

  private async request(operation: string, fields: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ id, operation, namespace: this.namespace, ...fields });
    });
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const reply = value as Partial<NativeReply>;
    if (typeof reply.id !== "string") return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(typeof reply.error === "string" ? reply.error : "Native archive operation failed"));
  }
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isChunkResult(value: unknown): value is { data: string; done: boolean; missing?: boolean } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { data?: unknown; done?: unknown; missing?: unknown };
  return typeof candidate.data === "string" && typeof candidate.done === "boolean"
    && (candidate.missing === undefined || typeof candidate.missing === "boolean");
}
