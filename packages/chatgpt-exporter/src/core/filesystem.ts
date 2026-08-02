// Adapted from GrokExporter commit 85922d6.
import { assertSafeRelativePath } from "./paths";

export interface ArchiveFileSystem {
  writeTextAtomic(path: string, content: string): Promise<void>;
  writeBytesAtomic(path: string, content: Uint8Array): Promise<void>;
  readText(path: string): Promise<string | undefined>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  exists(path: string): Promise<boolean>;
  writeByteChunksAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  readByteChunks(path: string, chunkSize?: number): AsyncIterable<Uint8Array>;
  listPaths(prefix?: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

export class DirectoryArchiveFileSystem implements ArchiveFileSystem {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async writeTextAtomic(path: string, content: string): Promise<void> {
    await this.writeBytesAtomic(path, new TextEncoder().encode(content));
  }

  async writeBytesAtomic(path: string, content: Uint8Array): Promise<void> {
    await this.writeByteChunksAtomic(path, oneChunk(content));
  }

  async writeByteChunksAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const { directory, name } = await this.resolveParent(path, true);
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      for await (const chunk of chunks) {
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        await writable.write(copy);
      }
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  }

  async *readByteChunks(path: string, chunkSize = 1_048_576): AsyncIterable<Uint8Array> {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize must be positive");
    const { directory, name } = await this.resolveParent(path, false);
    const file = await (await directory.getFileHandle(name)).getFile();
    for (let offset = 0; offset < file.size; offset += chunkSize) yield new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
  }

  async remove(path: string): Promise<void> {
    const { directory, name } = await this.resolveParent(path, false);
    await directory.removeEntry(name);
  }

  async listPaths(prefix = ""): Promise<string[]> {
    if (prefix) assertSafeRelativePath(prefix);
    const output: string[] = [];
    await this.walk(this.root, "", output);
    return output.filter((path) => !prefix || path === prefix || path.startsWith(`${prefix}/`)).sort();
  }

  async readText(path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    try {
      const { directory, name } = await this.resolveParent(path, false);
      const handle = await directory.getFileHandle(name);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.readBytes(path)) !== undefined;
  }

  private async resolveParent(path: string, create: boolean): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
    assertSafeRelativePath(path);
    const parts = path.replaceAll("\\", "/").split("/");
    const name = parts.pop();
    if (!name) throw new Error(`Path has no filename: ${path}`);
    let directory = this.root;
    for (const segment of parts) directory = await directory.getDirectoryHandle(segment, { create });
    return { directory, name };
  }

  private async walk(directory: FileSystemDirectoryHandle, base: string, output: string[]): Promise<void> {
    const iterable = directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    for await (const [name, handle] of iterable.entries()) {
      const path = base ? `${base}/${name}` : name;
      if (handle.kind === "file") output.push(path);
      else await this.walk(handle as FileSystemDirectoryHandle, path, output);
    }
  }
}

export class MemoryArchiveFileSystem implements ArchiveFileSystem {
  private readonly files = new Map<string, Uint8Array>();

  async writeTextAtomic(path: string, content: string): Promise<void> {
    await this.writeBytesAtomic(path, new TextEncoder().encode(content));
  }
  async writeBytesAtomic(path: string, content: Uint8Array): Promise<void> {
    assertSafeRelativePath(path);
    this.files.set(path, new Uint8Array(content));
  }
  async writeByteChunksAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    assertSafeRelativePath(path);
    const values: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of chunks) {
      const copy = new Uint8Array(chunk);
      values.push(copy);
      length += copy.byteLength;
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const value of values) {
      output.set(value, offset);
      offset += value.byteLength;
    }
    this.files.set(path, output);
  }
  async *readByteChunks(path: string, chunkSize = 1_048_576): AsyncIterable<Uint8Array> {
    const value = await this.readBytes(path);
    if (value === undefined) throw new DOMException("File not found", "NotFoundError");
    for (let offset = 0; offset < value.byteLength; offset += chunkSize) yield value.slice(offset, offset + chunkSize);
  }
  async remove(path: string): Promise<void> {
    assertSafeRelativePath(path);
    this.files.delete(path);
  }
  async listPaths(prefix = ""): Promise<string[]> {
    if (prefix) assertSafeRelativePath(prefix);
    return this.paths().filter((path) => !prefix || path === prefix || path.startsWith(`${prefix}/`));
  }
  async readText(path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }
  async readBytes(path: string): Promise<Uint8Array | undefined> {
    assertSafeRelativePath(path);
    const value = this.files.get(path);
    return value === undefined ? undefined : new Uint8Array(value);
  }
  async exists(path: string): Promise<boolean> {
    assertSafeRelativePath(path);
    return this.files.has(path);
  }
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

async function* oneChunk(content: Uint8Array): AsyncIterable<Uint8Array> {
  yield content;
}
