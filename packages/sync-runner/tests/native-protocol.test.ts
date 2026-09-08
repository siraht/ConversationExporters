import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("writes and commits a generation through real native-message framing", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-protocol-test-"));
  const child = spawn(process.execPath, ["dist/native-host.js"], { env: { ...process.env, CONVERSATION_SYNC_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
  let pending = Buffer.alloc(0);
  const waiting = new Map<string, (reply: { ok: boolean; result: unknown; error?: string }) => void>();
  child.stdout.on("data", (bytes: Buffer) => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const size = pending.readUInt32LE(0); const reply = JSON.parse(pending.subarray(4, size + 4).toString());
      pending = pending.subarray(size + 4); waiting.get(reply.id)?.(reply); waiting.delete(reply.id);
    }
  });
  async function ask(operation: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const id = randomUUID(); const body = Buffer.from(JSON.stringify({ id, namespace: "claude-web", operation, ...fields }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    const result = new Promise((resolve, reject) => { waiting.set(id, (reply) => reply.ok ? resolve(reply.result) : reject(new Error(reply.error))); });
    child.stdin.write(Buffer.concat([header, body])); return result;
  }
  try {
    const generationId = await ask("beginGeneration");
    async function write(path: string, content: string) {
      const writeId = randomUUID();
      await ask("writeStart", { generationId, path, writeId });
      await ask("writeChunk", { generationId, writeId, data: Buffer.from(content).toString("base64") });
      await ask("writeEnd", { generationId, writeId });
    }
    const content = "synthetic archive";
    await write("conversation.json", content);
    await write("_generation.json", JSON.stringify({ schema: "conversation-export-generation/1", id: generationId, namespace: "claude-web", account: "personal", createdAt: new Date().toISOString(), files: [{ path: "conversation.json", size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }] }));
    expect(await ask("commitGeneration", { generationId })).toMatchObject({ status: "queued", files: 1 });
    expect(await readFile(join(root, "outbox", String(generationId), "files", "conversation.json"), "utf8")).toBe(content);
    await expect(ask("writeStart", { generationId, path: "late.json", writeId: randomUUID() })).rejects.toThrow("Unknown generation");
  } finally { child.kill(); await new Promise<void>((resolve) => child.on("close", () => resolve())); await rm(root, { recursive: true, force: true }); }
});
