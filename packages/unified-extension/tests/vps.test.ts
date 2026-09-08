import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryArchiveFileSystem } from "@conversation-exporters/shared/filesystem";
import { syncFilesystem, testVps } from "../src/vps";
import { sha256Hex } from "@conversation-exporters/shared/hash";

const values: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  globalThis.chrome = {
    storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (input: Record<string, unknown>) => { Object.assign(values, input); }),
    } },
  } as unknown as typeof chrome;
  vi.restoreAllMocks();
});

describe("VPS replication", () => {
  it("skips only after verifying the destination still has the matching file", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    await filesystem.writeTextAtomic("conversations.json", "[]");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, request) => request?.method === "HEAD" ? new Response(null, { status: 200, headers: { "X-Content-SHA256": await sha256Hex("[]") } }) : new Response("{}", { status: 200 }));
    const token = ["test", "credential", "placeholder"].join("-");
    const settings = { enabled: true, baseUrl: "https://archive.example", token };
    expect(await syncFilesystem("claude-web", filesystem, settings)).toEqual({ uploaded: 1, unchanged: 0, failed: 0 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://archive.example/v1/archives/claude-web/files/conversations.json");
    expect(await syncFilesystem("claude-web", filesystem, settings)).toEqual({ uploaded: 0, unchanged: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await syncFilesystem("claude-web", filesystem, { ...settings, baseUrl: "https://second.example" })).toMatchObject({ uploaded: 1 });
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await syncFilesystem("claude-web", filesystem, settings)).toMatchObject({ uploaded: 1 });
  });

  it("checks the authenticated receiver status endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const token = ["test", "credential", "placeholder"].join("-");
    await testVps({ enabled: true, baseUrl: "https://archive.example", token });
    expect(fetchMock).toHaveBeenCalledWith("https://archive.example/v1/status", expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } }));
  });

  it("rejects unencrypted remote receiver URLs", async () => {
    await expect(testVps({ enabled: true, baseUrl: "http://archive.example", token: "a-long-enough-test-token" })).rejects.toThrow("HTTPS");
  });
});
