import { describe, expect, it } from "vitest";
import { IndexedDbArchiveFileSystem } from "../src/indexeddb-filesystem";

describe("IndexedDbArchiveFileSystem", () => {
  it("rejects unsafe namespaces before opening the browser database", () => {
    expect(() => new IndexedDbArchiveFileSystem("../escape")).toThrow("namespace");
  });
});
