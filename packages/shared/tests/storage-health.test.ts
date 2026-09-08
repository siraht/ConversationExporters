import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveStorageError, isQuotaError, requestPersistentArchive, storageEstimate } from "../src/storage-health";
afterEach(() => vi.unstubAllGlobals());
describe("storage recovery", () => {
  it("requests persistence when the origin is still best-effort", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persisted: async () => false, persist } });
    expect(await requestPersistentArchive()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });
  it("does not request persistence again when already granted", async () => {
    const persist = vi.fn();
    vi.stubGlobal("navigator", { storage: { persisted: async () => true, persist, estimate: async () => ({ usage: 100, quota: 1000 }) } });
    expect(await requestPersistentArchive()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(await storageEstimate()).toMatchObject({ usage: 100, quota: 1000, persisted: true });
  });
  it("preserves the original cause and gives non-destructive recovery instructions", () => {
    const error = archiveStorageError(new DOMException("transaction quota exceeded", "QuotaExceededError"));
    expect(isQuotaError(error)).toBe(true);
    expect(error.message).toContain("Do not remove the extension");
    const other = new Error("network"); expect(archiveStorageError(other)).toBe(other);
  });
});
