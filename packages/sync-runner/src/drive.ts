import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { SyncConfig } from "./types.js";

const INDEX_NAME = ".conversation-drive-index.json";
const COPY_BATCH_SIZE = 25;

interface DriveObject {
  ID: string;
  Path: string;
  MimeType?: string;
  ModTime?: string;
  Size?: number;
}

interface DriveIndexEntry {
  localPath: string;
  remotePath: string;
  archiveIdentity?: string;
  mimeType?: string;
  modTime?: string;
  size?: number;
}

interface DriveIndex {
  schema: "conversation-drive-index/1";
  identityAlgorithm?: "prompt-earliest-time-v1";
  objects: Record<string, DriveIndexEntry>;
}

export interface DriveCaptureSummary {
  provider: "google-ai-studio";
  discovered: number;
  copied: number;
  retained: number;
}

export async function captureAiStudio(config: SyncConfig): Promise<DriveCaptureSummary> {
  const destination = join(config.dataRoot, "live", "google-ai-studio");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const remote = `${config.driveRemote}:${config.drivePath}`;
  const objects = parseDriveListing(await output(config.rcloneBinary, [
    "lsjson", remote, "--recursive", "--files-only", "--metadata", "--log-level", "ERROR",
  ]));
  const indexPath = join(destination, INDEX_NAME);
  const prior = await loadIndex(indexPath);
  const trustedIdentities = prior.identityAlgorithm === "prompt-earliest-time-v1";
  const next: DriveIndex = { schema: "conversation-drive-index/1", identityAlgorithm: "prompt-earliest-time-v1", objects: { ...prior.objects } };

  const pairs: string[] = [];
  for (const object of objects) {
    const previous = prior.objects[object.ID];
    const localPath = previous?.localPath ?? driveObjectPath(object.ID, object.Path);
    next.objects[object.ID] = {
      localPath,
      remotePath: object.Path,
      ...(trustedIdentities && previous?.archiveIdentity ? { archiveIdentity: previous.archiveIdentity } : {}),
      ...(object.MimeType ? { mimeType: object.MimeType } : {}),
      ...(object.ModTime ? { modTime: object.ModTime } : {}),
      ...(typeof object.Size === "number" ? { size: object.Size } : {}),
    };
    const target = join(destination, localPath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (!previous || remoteChanged(previous, object) || !await isFile(target)) pairs.push(object.ID, target);
  }

  for (let index = 0; index < pairs.length; index += COPY_BATCH_SIZE * 2) {
    await quiet(config.rcloneBinary, [
      "backend", "copyid", `${config.driveRemote}:`, ...pairs.slice(index, index + COPY_BATCH_SIZE * 2),
      "--metadata", "--log-level", "ERROR",
    ]);
  }
  for (const object of objects) {
    const entry = next.objects[object.ID]!;
    if (!entry.archiveIdentity) {
      const identity = await promptIdentity(join(destination, entry.localPath));
      if (identity) entry.archiveIdentity = identity;
    }
  }
  await saveIndex(indexPath, next);
  return { provider: "google-ai-studio", discovered: objects.length, copied: pairs.length / 2, retained: Object.keys(next.objects).length };
}

export function parseDriveListing(text: string): DriveObject[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("AI Studio Drive listing was not valid JSON");
  }
  if (!Array.isArray(value)) throw new Error("AI Studio Drive listing was malformed");
  const objects = value.flatMap((item): DriveObject[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.ID !== "string" || !row.ID || typeof row.Path !== "string" || !row.Path) return [];
    return [{
      ID: row.ID,
      Path: row.Path,
      ...(typeof row.MimeType === "string" ? { MimeType: row.MimeType } : {}),
      ...(typeof row.ModTime === "string" ? { ModTime: row.ModTime } : {}),
      ...(typeof row.Size === "number" ? { Size: row.Size } : {}),
    }];
  });
  objects.sort((left, right) => left.ID.localeCompare(right.ID));
  if (new Set(objects.map((object) => object.ID)).size !== objects.length) {
    throw new Error("AI Studio Drive returned a duplicate object ID");
  }
  return objects;
}

export function driveObjectPath(id: string, remotePath: string): string {
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
  if (!safeId) throw new Error("AI Studio Drive returned an unsafe object ID");
  const rawName = basename(remotePath);
  const safeName = Array.from(rawName.replace(/[\u0000-\u001f\u007f]/g, "_")).slice(0, 160).join("");
  return join("drive-objects", safeId, safeName && safeName !== "." && safeName !== ".." ? safeName : "object");
}

export async function configureDrive(config: SyncConfig): Promise<void> {
  await inherited(config.rcloneBinary, ["config"]);
}

async function loadIndex(path: string): Promise<DriveIndex> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid index");
    const candidate = value as Partial<DriveIndex>;
    if (candidate.schema !== "conversation-drive-index/1" || !candidate.objects || typeof candidate.objects !== "object") {
      throw new Error("invalid index");
    }
    return candidate as DriveIndex;
  } catch (error) {
    if (isMissing(error)) return { schema: "conversation-drive-index/1", objects: {} };
    throw new Error("AI Studio Drive index was invalid");
  }
}

async function saveIndex(path: string, index: DriveIndex): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function output(command: string, arguments_: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error("AI Studio Drive listing failed")));
  });
}

async function quiet(command: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error("AI Studio Drive object copy failed")));
  });
}

async function inherited(command: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error("Drive configuration did not complete")));
  });
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function remoteChanged(previous: DriveIndexEntry, object: DriveObject): boolean {
  return previous.modTime !== object.ModTime || previous.size !== object.Size || previous.mimeType !== object.MimeType;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function promptIdentity(path: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prompt = value as Record<string, unknown>;
    if (!("runSettings" in prompt) || !("systemInstruction" in prompt) || !prompt.chunkedPrompt || typeof prompt.chunkedPrompt !== "object") return undefined;
    const chunks = (prompt.chunkedPrompt as Record<string, unknown>).chunks;
    const timestamps = Array.isArray(chunks) ? chunks.flatMap((chunk) => {
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return [];
      const timestamp = (chunk as Record<string, unknown>).createTime;
      return typeof timestamp === "string" && timestamp ? [timestamp] : [];
    }) : [];
    const identityBytes = timestamps.length
      ? `${JSON.stringify({ earliest_create_time: timestamps.sort()[0] })}\n`
      : bytes;
    return `prompt-${createHash("sha256").update(identityBytes).digest("hex")}`;
  } catch (error) {
    if (error instanceof SyntaxError || isMissing(error)) return undefined;
    throw error;
  }
}
