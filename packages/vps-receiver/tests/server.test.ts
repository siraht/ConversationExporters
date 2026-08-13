import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArchiveReceiver } from "../src/server.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("conversation archive receiver", () => {
  it("authenticates, validates hashes, and atomically stores archive files", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-receiver-")); roots.push(root);
    const token = ["test", "credential", "placeholder"].join("-");
    const server = createArchiveReceiver({ root, token, maxBytes: 1024 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/v1/status`)).status).toBe(401);
      expect((await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
      const body = new TextEncoder().encode("archived conversation");
      const hash = createHash("sha256").update(body).digest("hex");
      const response = await fetch(`${base}/v1/archives/gemini-web/files/nested/conversations.json`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "X-Content-SHA256": hash }, body });
      expect(response.status).toBe(200);
      expect(await readFile(join(root, "live/gemini-web/nested/conversations.json"), "utf8")).toBe("archived conversation");
      const bad = await fetch(`${base}/v1/archives/gemini-web/files/bad.json`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "X-Content-SHA256": "0".repeat(64) }, body });
      expect(bad.status).toBe(400);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
