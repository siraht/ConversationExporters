import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArchiveFileSystem } from "./filesystem";
import { assertSafeRelativePath } from "./paths";

export class NodeArchiveFileSystem implements ArchiveFileSystem {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async writeTextAtomic(path: string, content: string): Promise<void> {
    await this.writeBytesAtomic(path, new TextEncoder().encode(content));
  }

  async writeBytesAtomic(path: string, content: Uint8Array): Promise<void> {
    await this.writeByteChunksAtomic(path, (async function* () { yield content; })());
  }

  async writeByteChunksAtomic(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const target = this.target(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.node-${randomUUID()}.tmp`;
    const values: Uint8Array[] = [];
    try {
      for await (const chunk of chunks) values.push(new Uint8Array(chunk));
      await writeFile(temporary, Buffer.concat(values), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async *readByteChunks(path: string, chunkSize = 1_048_576): AsyncIterable<Uint8Array> {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize must be positive");
    for await (const chunk of createReadStream(this.target(path), { highWaterMark: chunkSize })) {
      yield new Uint8Array(chunk as Buffer);
    }
  }

  async readText(path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    try { return new Uint8Array(await readFile(this.target(path))); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async exists(path: string): Promise<boolean> {
    try { await stat(this.target(path)); return true; }
    catch (error) { if (isMissing(error)) return false; throw error; }
  }

  async byteSize(path: string): Promise<number | undefined> {
    try { return (await stat(this.target(path))).size; }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async listPaths(prefix = ""): Promise<string[]> {
    if (prefix) assertSafeRelativePath(prefix);
    const output: string[] = [];
    await this.walk(this.root, output);
    return output.filter((path) => !prefix || path === prefix || path.startsWith(`${prefix}/`)).sort();
  }

  async remove(path: string): Promise<void> {
    await unlink(this.target(path));
  }

  private target(path: string): string {
    assertSafeRelativePath(path);
    const target = resolve(this.root, path);
    if (target === this.root || !target.startsWith(`${this.root}/`)) throw new Error("Archive path escapes its root");
    return target;
  }

  private async walk(directory: string, output: string[]): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await this.walk(path, output);
      else if (entry.isFile()) output.push(relative(this.root, path).replaceAll("\\", "/"));
    }
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
