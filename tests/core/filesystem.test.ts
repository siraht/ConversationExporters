import { describe, expect, it } from "vitest";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { jsonLine, parseJson, prettyJson } from "../../src/core/serialization";

describe("archive filesystem", () => {
  it("copies writes and reads so callers cannot mutate durable state", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const bytes = new Uint8Array([1, 2, 3]);
    await filesystem.writeBytesAtomic("conversations/c1/source.bin", bytes);
    bytes[0] = 9;
    const firstRead = await filesystem.readBytes("conversations/c1/source.bin");
    expect(firstRead).toEqual(new Uint8Array([1, 2, 3]));
    firstRead![1] = 8;
    expect(await filesystem.readBytes("conversations/c1/source.bin")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects traversal and keeps stable path ordering", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    await filesystem.writeTextAtomic("z/file.txt", "z");
    await filesystem.writeTextAtomic("a/file.txt", "a");
    expect(filesystem.paths()).toEqual(["a/file.txt", "z/file.txt"]);
    await expect(filesystem.writeTextAtomic("../private.txt", "bad")).rejects.toThrow("Unsafe relative path");
  });
});

describe("JSON serialization", () => {
  it("writes stable pretty documents and JSON Lines", () => {
    expect(prettyJson({ z: 1, a: 2 })).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
    expect(jsonLine({ z: 1, a: 2 })).toBe('{"a":2,"z":1}\n');
    expect(parseJson<{ a: number }>("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJson("not-json")).toBeUndefined();
  });
});

