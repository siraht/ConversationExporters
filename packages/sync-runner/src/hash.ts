import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export async function fingerprintPath(path: string): Promise<string> {
  const root = resolve(path);
  const hash = createHash("sha256");
  const metadata = await lstat(root);
  await hashEntry(root, root, hash, !metadata.isDirectory());
  return hash.digest("hex");
}

async function hashEntry(root: string, path: string, hash: ReturnType<typeof createHash>, content: boolean): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`refusing to follow symbolic link: ${relative(root, path) || "."}`);
  }

  const name = relative(root, path) || ".";
  if (metadata.isDirectory()) {
    hash.update(`d\0${name}\0`);
    const entries = await readdir(path);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await hashEntry(root, join(path, entry), hash, false);
    }
    return;
  }

  if (!metadata.isFile()) {
    throw new Error(`unsupported source entry: ${name}`);
  }
  hash.update(`f\0${name}\0${metadata.size}\0${metadata.mtimeMs}\0`);
  if (!content) return;
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolveStream);
  });
}
