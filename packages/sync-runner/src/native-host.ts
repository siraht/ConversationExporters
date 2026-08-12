#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

interface RequestMessage {
  id: string;
  operation: string;
  namespace: "chatgpt-web" | "claude-web" | "gemini-web" | "grok-web";
  path?: string;
  prefix?: string;
  writeId?: string;
  data?: string;
  offset?: number;
  length?: number;
}

interface OpenWrite {
  stream: WriteStream;
  temporary: string;
  target: string;
}

const dataRoot = process.env.CONVERSATION_SYNC_ROOT || join(homedir(), "ConversationImports");
const writes = new Map<string, OpenWrite>();
let input = Buffer.alloc(0);
let queue = Promise.resolve();

process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  drain();
});

process.stdin.on("end", () => {
  for (const write of writes.values()) write.stream.destroy();
});

function drain(): void {
  while (input.byteLength >= 4) {
    const length = input.readUInt32LE(0);
    if (length > 1_048_576) process.exit(2);
    if (input.byteLength < length + 4) return;
    const payload = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    queue = queue.then(async () => {
      let id = "unknown";
      try {
        const request = JSON.parse(payload.toString("utf8")) as RequestMessage;
        id = typeof request.id === "string" ? request.id : id;
        write({ id, ok: true, result: await execute(request) });
      } catch (error) {
        write({ id, ok: false, error: error instanceof Error ? error.message : "native archive operation failed" });
      }
    });
  }
}

async function execute(request: RequestMessage): Promise<unknown> {
  if (!request || typeof request.id !== "string") throw new Error("invalid native request");
  const root = namespaceRoot(request.namespace);
  switch (request.operation) {
    case "writeStart": {
      const target = targetPath(root, request.path);
      const writeId = requiredToken(request.writeId, "write ID");
      if (writes.has(writeId)) throw new Error("write already exists");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.native-${randomUUID()}.tmp`;
      const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      await new Promise<void>((resolveOpen, reject) => {
        stream.once("open", () => resolveOpen());
        stream.once("error", reject);
      });
      writes.set(writeId, { stream, temporary, target });
      return true;
    }
    case "writeChunk": {
      const current = requireWrite(request.writeId);
      if (typeof request.data !== "string" || request.data.length > 400_000) throw new Error("invalid write chunk");
      const bytes = Buffer.from(request.data, "base64");
      if (!current.stream.write(bytes)) await new Promise<void>((resolveDrain) => current.stream.once("drain", resolveDrain));
      return bytes.byteLength;
    }
    case "writeEnd": {
      const writeId = requiredToken(request.writeId, "write ID");
      const current = requireWrite(writeId);
      await new Promise<void>((resolveEnd, reject) => current.stream.end((error?: Error | null) => error ? reject(error) : resolveEnd()));
      await rename(current.temporary, current.target);
      writes.delete(writeId);
      return true;
    }
    case "writeAbort": {
      const writeId = requiredToken(request.writeId, "write ID");
      const current = writes.get(writeId);
      if (current) {
        current.stream.destroy();
        await unlink(current.temporary).catch(() => undefined);
        writes.delete(writeId);
      }
      return true;
    }
    case "readChunk": {
      const target = targetPath(root, request.path);
      const offset = safeInteger(request.offset, 0, Number.MAX_SAFE_INTEGER, "offset");
      const length = safeInteger(request.length, 1, 262_144, "length");
      try {
        const metadata = await stat(target);
        const handle = await open(target, "r");
        try {
          const buffer = Buffer.alloc(Math.min(length, Math.max(0, metadata.size - offset)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          return { data: buffer.subarray(0, bytesRead).toString("base64"), done: offset + bytesRead >= metadata.size };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (isMissing(error)) return { data: "", done: true, missing: true };
        throw error;
      }
    }
    case "exists": {
      try { await stat(targetPath(root, request.path)); return true; }
      catch (error) { if (isMissing(error)) return false; throw error; }
    }
    case "list": {
      const prefix = targetPath(root, request.prefix, true);
      const base = root;
      return (await walk(root)).filter((path) => {
        const absolute = resolve(root, path);
        return absolute === prefix || absolute.startsWith(`${prefix}/`);
      }).map((path) => relative(base, resolve(base, path)).replaceAll("\\", "/")).sort();
    }
    case "remove": {
      await unlink(targetPath(root, request.path));
      return true;
    }
    default:
      throw new Error("unsupported native archive operation");
  }
}

function namespaceRoot(namespace: RequestMessage["namespace"]): string {
  if (namespace !== "chatgpt-web" && namespace !== "claude-web" && namespace !== "gemini-web" && namespace !== "grok-web") {
    throw new Error("unsupported archive namespace");
  }
  return resolve(dataRoot, "live", namespace);
}

function targetPath(root: string, value: string | undefined, allowEmpty = false): string {
  if (value === "" && allowEmpty) return root;
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")) throw new Error("unsafe archive path");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("unsafe archive path");
  const target = resolve(root, ...segments);
  if (!target.startsWith(`${root}/`)) throw new Error("unsafe archive path");
  return target;
}

async function walk(root: string, directory = root): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const output: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) output.push(...await walk(root, absolute));
      else if (entry.isFile()) output.push(relative(root, absolute));
    }
    return output;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function requireWrite(value: string | undefined): OpenWrite {
  const write = writes.get(requiredToken(value, "write ID"));
  if (!write) throw new Error("write does not exist");
  return write;
}

function requiredToken(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function safeInteger(value: number | undefined, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value! < minimum || value! > maximum) throw new Error(`invalid ${label}`);
  return value!;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function write(value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength);
  process.stdout.write(Buffer.concat([header, body]));
}
