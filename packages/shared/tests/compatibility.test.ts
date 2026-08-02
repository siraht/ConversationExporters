import { describe, expect, it } from "vitest";
import { MemoryArchiveFileSystem } from "../src/filesystem";
import { hashJson, sha256Hex } from "../src/hash";
import { stableStringify } from "../src/json";
import { assertSafeRelativePath, extensionFromMediaType, safePathSegment } from "../src/paths";
import { jsonLine, parseJson, prettyJson } from "../src/serialization";

describe("accepted exporter compatibility primitives", () => {
  it("preserves stable JSON, hashing, and serialization behavior", async () => {
    const value = { z: 2, nested: { b: true, a: null }, a: [3, 1] };
    expect(stableStringify(value)).toBe('{"a":[3,1],"nested":{"a":null,"b":true},"z":2}');
    expect(await hashJson(value)).toBe(await sha256Hex(stableStringify(value)));
    expect(prettyJson(value)).toBe(`${JSON.stringify(JSON.parse(stableStringify(value)), null, 2)}\n`);
    expect(jsonLine(value)).toBe(`${stableStringify(value)}\n`);
    expect(parseJson<typeof value>(JSON.stringify(value))).toEqual(value);
  });

  it("keeps the accepted safe-path and media-extension union", () => {
    expect(safePathSegment("  CON  ")).toBe("_CON");
    expect(() => assertSafeRelativePath("../private")).toThrow();
    expect(extensionFromMediaType(undefined)).toBe("bin");
    expect(extensionFromMediaType("text/html")).toBe("html");
    expect(extensionFromMediaType(null, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
  });

  it("provides the streaming superset without changing ordinary file semantics", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    await filesystem.writeTextAtomic("conversations/example/value.txt", "hello");
    expect(await filesystem.readText("conversations/example/value.txt")).toBe("hello");
    expect(await filesystem.listPaths("conversations/example")).toEqual(["conversations/example/value.txt"]);
    await filesystem.writeByteChunksAtomic("assets/value.bin", (async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    })());
    expect([...await collect(filesystem.readByteChunks("assets/value.bin", 2))]).toEqual([1, 2, 3]);
  });
});

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: number[] = [];
  for await (const chunk of chunks) values.push(...chunk);
  return new Uint8Array(values);
}

