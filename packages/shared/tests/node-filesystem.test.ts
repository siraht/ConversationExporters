import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NodeArchiveFileSystem } from "../src/node-filesystem";

test("node filesystem writes, sizes, lists, streams, and removes archive files", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-node-filesystem-"));
  const filesystem = new NodeArchiveFileSystem(root);
  await filesystem.writeTextAtomic("nested/value.txt", "hello");
  expect(await filesystem.byteSize("nested/value.txt")).toBe(5);
  expect(await filesystem.listPaths()).toEqual(["nested/value.txt"]);
  const chunks: Uint8Array[] = [];
  for await (const chunk of filesystem.readByteChunks("nested/value.txt", 2)) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("hello");
  expect((await readFile(join(root, "nested/value.txt"))).toString()).toBe("hello");
  await filesystem.remove("nested/value.txt");
  expect(await filesystem.exists("nested/value.txt")).toBe(false);
});
