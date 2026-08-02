import { describe, expect, it } from "vitest";

import { MemoryArchiveFileSystem } from "../../src/core/filesystem";

describe("streaming archive filesystem", () => {
  it("writes, reads, copies, and removes byte chunks", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    await filesystem.writeByteChunksAtomic("staging/file.bin", chunks(["one", "two", "three"]));
    const read: string[] = [];
    for await (const chunk of filesystem.readByteChunks("staging/file.bin", 3)) read.push(new TextDecoder().decode(chunk));
    expect(read.join("")).toBe("onetwothree");
    await filesystem.writeByteChunksAtomic("assets/final.bin", filesystem.readByteChunks("staging/file.bin", 2));
    expect(new TextDecoder().decode((await filesystem.readBytes("assets/final.bin"))!)).toBe("onetwothree");
    expect(await filesystem.listPaths("assets")).toEqual(["assets/final.bin"]);
    await filesystem.remove("staging/file.bin");
    expect(await filesystem.exists("staging/file.bin")).toBe(false);
  });
});

async function* chunks(values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}
