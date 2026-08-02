export interface DirectoryHandleStore {
  save(handle: FileSystemDirectoryHandle): Promise<void>;
  load(): Promise<FileSystemDirectoryHandle | undefined>;
  ensurePermission(handle: FileSystemDirectoryHandle, request: boolean): Promise<boolean>;
}

export function createDirectoryHandleStore(databaseName: string): DirectoryHandleStore {
  const storeName = "handles";
  const key = "archive-directory";

  async function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const value = database.transaction(storeName, mode);
        const request = operation(value.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        value.onerror = () => reject(value.error);
      });
    } finally {
      database.close();
    }
  }

  return {
    async save(handle) {
      await transaction("readwrite", (store) => store.put(handle, key));
    },
    async load() {
      return await transaction("readonly", (store) => store.get(key)) as FileSystemDirectoryHandle | undefined;
    },
    async ensurePermission(handle, request) {
      const permissionHandle = handle as FileSystemDirectoryHandle & {
        queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
        requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
      };
      if (await permissionHandle.queryPermission({ mode: "readwrite" }) === "granted") return true;
      return request && await permissionHandle.requestPermission({ mode: "readwrite" }) === "granted";
    },
  };
}

