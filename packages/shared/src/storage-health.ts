export interface StorageHealth { usage?: number; quota?: number; persisted: boolean; writable: boolean; error?: string }

export function isQuotaError(error: unknown): boolean {
  return error instanceof Error && (error.name === "QuotaExceededError" || /quota|storage.*full/i.test(error.message));
}

export async function requestPersistentArchive(): Promise<boolean> {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage) return false;
    return await storage.persisted() || await storage.persist();
  } catch { return false; }
}

export async function storageEstimate(): Promise<Omit<StorageHealth, "writable">> {
  const storage = globalThis.navigator?.storage;
  const estimate = await storage?.estimate?.().catch(() => ({})) ?? {};
  return { ...estimate, persisted: await storage?.persisted?.().catch(() => false) ?? false };
}

export function archiveStorageError(error: unknown): Error {
  if (!isQuotaError(error)) return error instanceof Error ? error : new Error("Archive write failed");
  const result = new Error(`Browser archive storage is full or quota-limited. Existing conversations were retained. Open the dashboard and click Repair storage, then retry. Do not remove the extension or clear its data; export or replicate the existing archive first. Cause: ${error instanceof Error ? error.message : "quota exhausted"}`);
  result.name = "QuotaExceededError";
  return result;
}
