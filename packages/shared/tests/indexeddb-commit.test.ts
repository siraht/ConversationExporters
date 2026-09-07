import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbArchiveFileSystem } from "../src/indexeddb-filesystem";

afterEach(() => vi.unstubAllGlobals());

function database() {
  const put: { onsuccess?: () => void } = {};
  const transaction = { objectStore: () => ({ put: () => put }), oncomplete: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
    error: null as Error | null, abort: vi.fn() };
  const db = { transaction: () => transaction, close: vi.fn() };
  vi.stubGlobal("indexedDB", { open: () => {
    const request = { result: db, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } });
  return { put, transaction, db };
}

describe("IndexedDB commit acknowledgement", () => {
  it("waits for transaction completion after request success", async () => {
    const { put, transaction, db } = database();
    let settled = false;
    const write = new IndexedDbArchiveFileSystem("test").writeTextAtomic("file.json", "{}").then(() => { settled = true; });
    await vi.waitFor(() => expect(put.onsuccess).toBeTypeOf("function"));
    put.onsuccess?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    transaction.oncomplete?.();
    await write;
    expect(settled).toBe(true);
    expect(db.close).toHaveBeenCalledOnce();
  });
  it("rejects an abort occurring after request success", async () => {
    const { put, transaction } = database();
    const write = new IndexedDbArchiveFileSystem("test").writeTextAtomic("file.json", "{}");
    const rejected = expect(write).rejects.toThrow("quota exhausted");
    await vi.waitFor(() => expect(put.onsuccess).toBeTypeOf("function"));
    put.onsuccess?.();
    transaction.error = new Error("quota exhausted");
    transaction.onabort?.();
    await rejected;
  });
});
