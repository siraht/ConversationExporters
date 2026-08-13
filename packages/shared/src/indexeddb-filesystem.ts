import type { ArchiveFileSystem } from "./filesystem";
import { assertSafeRelativePath } from "./paths";

const DATABASE = "conversation-exporters-archives";
const STORE = "files";
interface StoredFile { key: string; bytes: Blob }
export interface BrowserArchiveEntry { namespace: string; path: string; blob: Blob }

export class IndexedDbArchiveFileSystem implements ArchiveFileSystem {
  constructor(private readonly namespace: string, private readonly prefix = "") {
    if (!/^[a-z0-9-]+$/.test(namespace)) throw new Error("Invalid archive namespace");
    if (prefix) assertSafeRelativePath(prefix);
  }
  async writeTextAtomic(path: string, content: string): Promise<void> { await this.writeBytesAtomic(path, new TextEncoder().encode(content)); }
  async writeBytesAtomic(path: string, content: Uint8Array): Promise<void> { await this.put(path, new Blob([ownedBuffer(content)])); }
  async writeByteChunksAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const parts: ArrayBuffer[] = []; for await (const chunk of chunks) parts.push(ownedBuffer(chunk)); await this.put(path, new Blob(parts));
  }
  async *readByteChunks(path: string, chunkSize = 1_048_576): AsyncIterable<Uint8Array> {
    const blob = await this.blob(path); if (!blob) throw new DOMException("File not found", "NotFoundError");
    for (let offset = 0; offset < blob.size; offset += chunkSize) yield new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
  }
  async readText(path: string): Promise<string | undefined> { return (await this.blob(path))?.text(); }
  async readBytes(path: string): Promise<Uint8Array | undefined> { const value = await this.blob(path); return value ? new Uint8Array(await value.arrayBuffer()) : undefined; }
  async exists(path: string): Promise<boolean> { return (await this.blob(path)) !== undefined; }
  async byteSize(path: string): Promise<number | undefined> { return (await this.blob(path))?.size; }
  async listPaths(prefix = ""): Promise<string[]> {
    if (prefix) assertSafeRelativePath(prefix); const base = this.key(prefix, true);
    const keys = await transact<string[]>("readonly", (store, resolve, reject) => {
      const output: string[] = []; const request = store.openKeyCursor(IDBKeyRange.bound(base, `${base}\uffff`));
      request.onerror = () => reject(request.error ?? new Error("Archive cursor failed"));
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve(output); output.push(String(cursor.key)); cursor.continue(); };
    });
    const root = this.key("", true); return keys.map((key) => key.slice(root.length)).filter(Boolean).sort();
  }
  async remove(path: string): Promise<void> { await transact<void>("readwrite", (store, resolve, reject) => { const request = store.delete(this.key(path)); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error!); }); }
  async ready(): Promise<void> { await this.listPaths(); }
  private async put(path: string, bytes: Blob): Promise<void> { const key = this.key(path); await transact<void>("readwrite", (store, resolve, reject) => { const request = store.put({ key, bytes } satisfies StoredFile); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error!); }); }
  private async blob(path: string): Promise<Blob | undefined> { const value = await transact<StoredFile | undefined>("readonly", (store, resolve, reject) => { const request = store.get(this.key(path)); request.onsuccess = () => resolve(request.result as StoredFile | undefined); request.onerror = () => reject(request.error!); }); return value?.bytes; }
  private key(path: string, allowEmpty = false): string {
    if (path) assertSafeRelativePath(path); else if (!allowEmpty) throw new Error("Archive path is empty");
    const root = `${this.namespace}/${this.prefix ? `${this.prefix}/` : ""}`;
    return `${root}${path}${allowEmpty && path ? "/" : ""}`;
  }
}

export async function listBrowserArchiveEntries(namespace?: string): Promise<BrowserArchiveEntry[]> {
  if (namespace !== undefined && !/^[a-z0-9-]+$/.test(namespace)) throw new Error("Invalid archive namespace");
  const records = await transact<StoredFile[]>("readonly", (store, resolve, reject) => {
    const output: StoredFile[] = [];
    const request = store.openCursor(namespace ? IDBKeyRange.bound(`${namespace}/`, `${namespace}/\uffff`) : undefined);
    request.onerror = () => reject(request.error ?? new Error("Archive cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(output);
      output.push(cursor.value as StoredFile);
      cursor.continue();
    };
  });
  return records.map(({ key, bytes }) => {
    const separator = key.indexOf("/");
    return { namespace: key.slice(0, separator), path: key.slice(separator + 1), blob: bytes };
  }).sort((left, right) => `${left.namespace}/${left.path}`.localeCompare(`${right.namespace}/${right.path}`));
}

async function openDatabase(): Promise<IDBDatabase> { return await new Promise((resolve, reject) => { const request = indexedDB.open(DATABASE, 1); request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error!); }); }
async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> { const db = await openDatabase(); try { return await new Promise<T>((resolve, reject) => operation(db.transaction(STORE, mode).objectStore(STORE), resolve, reject)); } finally { db.close(); } }

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
