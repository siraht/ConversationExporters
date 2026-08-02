import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/core/hash";
import { IncrementalSha256 } from "../../src/core/sha256-stream";

describe("incremental SHA-256", () => {
  it("matches Web Crypto across empty, boundary, and multi-block chunking", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1_000_000]) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = index % 251;
      const hash = new IncrementalSha256();
      for (let offset = 0; offset < length; offset += 37) hash.update(bytes.subarray(offset, Math.min(offset + 37, length)));
      expect(hash.digestHex()).toBe(await sha256Hex(bytes));
    }
  });

  it("matches the standard abc vector", () => {
    expect(new IncrementalSha256().update(new TextEncoder().encode("abc")).digestHex())
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
