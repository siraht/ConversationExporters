import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const NAMESPACES = new Set(["chatgpt-web", "claude-web", "gemini-web", "google-ai-studio", "grok-web"]);

export interface ReceiverOptions { root: string; token: string; maxBytes?: number }

export function createArchiveReceiver(options: ReceiverOptions): Server {
  const root = resolve(options.root);
  if (options.token.length < 16) throw new Error("ARCHIVE_RECEIVER_TOKEN must contain at least 16 characters");
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  return createServer((request, response) => void route(request, response, { root, token: options.token, maxBytes }).catch((error) => {
    if (!response.headersSent) json(response, 500, { ok: false, error: error instanceof Error ? error.message : "receiver failed" });
    else response.destroy();
  }));
}

async function route(request: IncomingMessage, response: ServerResponse, options: Required<ReceiverOptions>): Promise<void> {
  cors(response);
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (!authorized(request, options.token)) { json(response, 401, { ok: false, error: "unauthorized" }); return; }
  const url = new URL(request.url ?? "/", "http://receiver.invalid");
  if (request.method === "GET" && url.pathname === "/v1/status") { json(response, 200, { ok: true, service: "conversation-archive-receiver", version: 1 }); return; }
  const match = /^\/v1\/archives\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
  if (request.method !== "PUT" || !match) { json(response, 404, { ok: false, error: "not found" }); return; }
  const namespace = decode(match[1]!);
  if (!NAMESPACES.has(namespace)) { json(response, 400, { ok: false, error: "unsupported archive namespace" }); return; }
  const parts = match[2]!.split("/").map(decode);
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0"))) {
    json(response, 400, { ok: false, error: "unsafe archive path" }); return;
  }
  const base = resolve(options.root, "live", namespace);
  const destination = resolve(base, ...parts);
  if (destination !== base && !destination.startsWith(`${base}${sep}`)) { json(response, 400, { ok: false, error: "unsafe archive path" }); return; }
  const expectedHash = request.headers["x-content-sha256"];
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) { json(response, 400, { ok: false, error: "missing or invalid content hash" }); return; }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.upload-${randomUUID()}`;
  let size = 0;
  const hash = createHash("sha256");
  const file = await open(temporary, "wx", 0o600);
  try {
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      size += chunk.byteLength;
      if (size > options.maxBytes) throw new ClientError(413, "archive file exceeds configured limit");
      hash.update(chunk);
      await file.write(chunk);
    }
    await file.sync();
    const actualHash = hash.digest("hex");
    if (actualHash !== expectedHash) throw new ClientError(400, "content hash mismatch");
    await file.close();
    await rename(temporary, destination);
    json(response, 200, { ok: true, namespace, path: parts.join("/"), bytes: size, sha256: actualHash });
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    if (error instanceof ClientError) json(response, error.status, { ok: false, error: error.message });
    else throw error;
  }
}

class ClientError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function decode(value: string): string { try { return decodeURIComponent(value); } catch { throw new ClientError(400, "invalid path encoding"); } }
function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(supplied); const right = Buffer.from(token);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function cors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Content-SHA256");
}
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.ARCHIVE_RECEIVER_ROOT;
  const token = process.env.ARCHIVE_RECEIVER_TOKEN;
  if (!root || !token) throw new Error("Set ARCHIVE_RECEIVER_ROOT and ARCHIVE_RECEIVER_TOKEN");
  const host = process.env.ARCHIVE_RECEIVER_HOST ?? "127.0.0.1";
  const port = Number(process.env.ARCHIVE_RECEIVER_PORT ?? "8787");
  const server = createArchiveReceiver({ root, token });
  server.listen(port, host, () => process.stdout.write(`Conversation archive receiver listening on http://${host}:${port}\n`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
}
