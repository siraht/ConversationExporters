import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationStore, durableJson } from "../src/generations.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "archive-generation-test-")); roots.push(root);
  return new GenerationStore(root);
}
function entry(content: string) { return { path: "conversation.json", size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }; }
async function manifest(store: GenerationStore, id: string, content: string) {
  const root = await store.filesRoot(id, "claude-web");
  await durableJson(join(root, "_generation.json"), { schema: "conversation-export-generation/1", id, namespace: "claude-web", account: "personal", createdAt: new Date().toISOString(), files: [entry(content)] });
  return root;
}
describe("committed generations", () => {
  it("publishes only verified files and reuses immutable content", async () => {
    const store = await setup(); const id = await store.begin("claude-web");
    const root = await manifest(store, id, "first"); await writeFile(join(root, "conversation.json"), "first");
    expect(await store.commit(id, "claude-web")).toMatchObject({ status: "queued", files: 1, bytes: 5 });
    const second = await store.begin("claude-web");
    expect(await store.reuse(second, "claude-web", entry("first"))).toBe(true);
    await manifest(store, second, "first"); await store.commit(second, "claude-web");
    expect(await readdir(join(store.root, "objects"))).toHaveLength(1);
    expect(await readFile(join(store.root, "outbox", id, "files", "conversation.json"), "utf8")).toBe("first");
  });
  it("does not publish corrupt or incomplete generations", async () => {
    const store = await setup(); const id = await store.begin("claude-web"); const root = await manifest(store, id, "expected");
    await writeFile(join(root, "conversation.json"), "wrong");
    await expect(store.commit(id, "claude-web")).rejects.toThrow("mismatch");
    await expect(readdir(join(store.root, "outbox"))).rejects.toThrow();
  });
  it("rejects namespace crossover and path traversal", async () => {
    const store = await setup(); const id = await store.begin("claude-web");
    await expect(store.filesRoot(id, "grok-web")).rejects.toThrow("namespace");
    await expect(store.begin("../outside")).rejects.toThrow("namespace");
  });
});
