import { beforeEach, expect, it, vi } from "vitest";
const files = new Map<string, string>();
vi.mock("@conversation-exporters/shared/indexeddb-filesystem", () => ({ IndexedDbArchiveFileSystem: class {
  constructor(private namespace: string) {}
  async writeTextAtomic(path: string, value: string) { files.set(`${this.namespace}/${path}`, value); }
  async readText(path: string) { return files.get(`${this.namespace}/${path}`); }
  async listPaths() { return [...files.keys()].filter((path) => path.startsWith(`${this.namespace}/`)).map((path) => path.slice(this.namespace.length + 1)); }
} }));
let store: typeof import("../src/run-store");
let local: Record<string, unknown>;
beforeEach(async () => {
  vi.resetModules(); files.clear(); local = {};
  vi.stubGlobal("chrome", { action: { setBadgeText: vi.fn(), setTitle: vi.fn() }, storage: { local: { get: async () => local, set: async (value: Record<string, unknown>) => { Object.assign(local, value); } } } });
  store = await import("../src/run-store");
});
it("persists separate provider counters and visited phases, retaining every finished run", async () => {
  await store.beginRun(["claude", "grok"], "manual");
  store.updateProvider("claude", { phase: "assets", status: "running", fetched: 3 });
  store.updateProvider("grok", { phase: "discovery", status: "running", discovered: 50 });
  store.updateProvider("claude", { phase: "complete", status: "complete" });
  store.updateProvider("grok", { status: "failed", message: "Provider unavailable" });
  await store.finishRun();
  await store.beginRun(["gemini"], "scheduled");
  store.updateProvider("gemini", { phase: "complete", status: "complete" });
  await store.finishRun();
  const history = await store.runHistory();
  expect(history.total).toBe(2);
  const manual = history.runs.find((run) => run.trigger === "manual")!;
  expect(manual.status).toBe("partial");
  expect(manual.providers.claude?.fetched).toBe(3);
  expect(manual.providers.claude?.phases?.assets).toBeDefined();
  expect(manual.providers.claude?.phases?.validation).toBeUndefined();
  expect(manual.providers.grok?.discovered).toBe(50);
  expect((await store.runHistory(1, 1)).runs).toHaveLength(1);
});
it("marks active and queued providers interrupted after background restart", async () => {
  await store.beginRun(["claude", "grok"], "scheduled");
  const snapshot = local[store.RUN_PROGRESS_KEY] as import("../src/run-store").RunProgress;
  snapshot.providers.claude!.status = "running";
  await store.recoverRun();
  const [run] = (await store.runHistory()).runs;
  expect(run?.status).toBe("interrupted");
  expect(run?.providers.grok?.status).toBe("interrupted");
  expect(JSON.parse(files.get("claude-web/validation.json")!).valid).toBe(false);
  expect(files.has("grok-web/validation.json")).toBe(false);
});
it("cancels queued providers while keeping completed provider results", async () => {
  await store.beginRun(["claude", "grok"], "manual");
  store.updateProvider("claude", { phase: "complete", status: "complete", fetched: 4 });
  await store.finishRun(true);
  const [run] = (await store.runHistory()).runs;
  expect(run?.status).toBe("cancelled");
  expect(run?.providers.claude?.status).toBe("complete");
  expect(run?.providers.grok?.status).toBe("cancelled");
});
