import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryArchiveFileSystem } from "@conversation-exporters/shared/filesystem";
import { syncFilesystem, testVps } from "../src/vps";

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
  it("uploads changed files and skips matching local state", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    await filesystem.writeTextAtomic("conversations.json", "[]");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const token = ["test", "credential", "placeholder"].join("-");
    const settings = { enabled: true, baseUrl: "https://archive.example", token };
    expect(await syncFilesystem("claude-web", filesystem, settings)).toEqual({ uploaded: 1, unchanged: 0, failed: 0 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://archive.example/v1/archives/claude-web/files/conversations.json");
    expect(await syncFilesystem("claude-web", filesystem, settings)).toEqual({ uploaded: 0, unchanged: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
