import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const NAMESPACES = ["chatgpt-web", "claude-web", "gemini-web", "google-ai-studio", "grok-web", "run-history"] as const;
export interface GenerationFile { path: string; sha256: string; size: number }
export interface GenerationManifest {
  schema: "conversation-export-generation/1"; id: string; namespace: string; account: string;
  createdAt: string; files: GenerationFile[];
}
export function safePath(root: string, path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || path.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("Unsafe generation path");
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}/`)) throw new Error("Unsafe generation path");
  return target;
}
export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export class GenerationStore {
  constructor(readonly root: string) {}
  staging(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid generation ID");
    return join(this.root, ".generations", id);
  }
  async begin(namespace: string): Promise<string> {
    if (!NAMESPACES.includes(namespace as typeof NAMESPACES[number])) throw new Error("Unsupported namespace");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const capacity = await statfs(this.root);
    const floor = Number(process.env.CONVERSATION_MIN_FREE_BYTES ?? 2 * 1024 ** 3);
    if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("Invalid minimum free space");
    if (capacity.bavail * capacity.bsize < floor) throw new Error("Local export disk is low on space; pending archives were retained");
    const id = randomUUID();
    await mkdir(join(this.staging(id), "files"), { recursive: true, mode: 0o700 });
    await durableJson(join(this.staging(id), "owner.json"), { namespace });
    return id;
  }
  async filesRoot(id: string, namespace: string): Promise<string> {
    const owner = JSON.parse(await readFile(join(this.staging(id), "owner.json"), "utf8")) as { namespace: string };
    if (owner.namespace !== namespace) throw new Error("Generation namespace mismatch");
    return join(this.staging(id), "files");
  }
  async reuse(id: string, namespace: string, entry: GenerationFile): Promise<boolean> {
    validateEntry(entry);
    const root = await this.filesRoot(id, namespace);
    const blob = join(this.root, "objects", entry.sha256);
    try {
      const metadata = await lstat(blob);
      if (!metadata.isFile() || metadata.size !== entry.size || await digestFile(blob) !== entry.sha256) return false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    const target = safePath(root, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await link(blob, target);
    return true;
  }
  async commit(id: string, namespace: string): Promise<{ id: string; status: "queued"; files: number; bytes: number }> {
    const root = await this.filesRoot(id, namespace);
    const manifest = JSON.parse(await readFile(join(root, "_generation.json"), "utf8")) as GenerationManifest;
    if (manifest.schema !== "conversation-export-generation/1" || manifest.id !== id || manifest.namespace !== namespace || !/^[a-zA-Z0-9._-]{1,128}$/.test(manifest.account) || !Array.isArray(manifest.files)) throw new Error("Invalid generation manifest");
    const seen = new Set<string>();
    let bytes = 0;
    await mkdir(join(this.root, "objects"), { recursive: true, mode: 0o700 });
    for (const entry of manifest.files) {
      validateEntry(entry);
      if (seen.has(entry.path) || entry.path === "_generation.json") throw new Error("Duplicate/reserved generation path");
      seen.add(entry.path);
      const path = safePath(root, entry.path);
      await assertRegularPath(root, entry.path);
      const info = await lstat(path);
      if (info.size !== entry.size || await digestFile(path) !== entry.sha256) throw new Error("Generation content hash or size mismatch");
      const file = await open(path, "r");
      try { await file.sync(); } finally { await file.close(); }
      const blob = join(this.root, "objects", entry.sha256);
      try { await link(path, blob); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await digestFile(blob) !== entry.sha256) throw new Error("Existing archive object is corrupt");
      }
      bytes += entry.size;
    }
    const actual = await walkFiles(root);
    if (actual.some((path) => path !== "_generation.json" && !seen.has(path))) throw new Error("Unlisted generation file");
    await durableJson(join(this.staging(id), "receipt.json"), { id, status: "queued", files: seen.size, bytes });
    await syncDirectory(root);
    await mkdir(join(this.root, "outbox"), { recursive: true, mode: 0o700 });
    await rename(this.staging(id), join(this.root, "outbox", id));
    await syncDirectory(join(this.root, "outbox"));
    return { id, status: "queued", files: seen.size, bytes };
  }
}
function validateEntry(entry: GenerationFile): void {
  if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Invalid generation file");
}
async function assertRegularPath(root: string, path: string): Promise<void> {
  let current = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error("Unsafe generation file type");
  }
}
export async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await walkFiles(root, path));
    else if (entry.isFile()) output.push(path);
    else throw new Error("Unsupported archive file type");
  }
  return output.sort();
}
