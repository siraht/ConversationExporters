import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SyncState } from "./types.js";

export function emptyState(): SyncState {
  return { schema: "conversation-sync-state/1", sources: {} };
}

export async function loadState(path: string): Promise<SyncState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isState(parsed)) throw new Error("invalid sync state schema");
    return parsed;
  } catch (error) {
    if (isMissing(error)) return emptyState();
    throw error;
  }
}

export async function saveState(path: string, state: SyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function withLock<T>(dataRoot: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const lock = join(dataRoot, ".sync.lock");
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch (error) {
    if (isExists(error)) throw new Error("another conversation sync is already running");
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

function isState(value: unknown): value is SyncState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SyncState>;
  return candidate.schema === "conversation-sync-state/1"
    && typeof candidate.sources === "object"
    && candidate.sources !== null;
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
