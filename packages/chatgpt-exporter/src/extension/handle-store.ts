// Directory-handle storage adapted from GrokExporter commit 85922d6.
const DATABASE = "chatgpt-exporter";
const STORE = "handles";
const KEY = "archive-directory";

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const database = await openDatabase();
  await transactionPromise(database, "readwrite", (store) => store.put(handle, KEY));
  database.close();
}

export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const database = await openDatabase();
  const value = await transactionPromise(database, "readonly", (store) => store.get(KEY));
  database.close();
  return value as FileSystemDirectoryHandle | undefined;
}

export async function ensureDirectoryPermission(handle: FileSystemDirectoryHandle, request: boolean): Promise<boolean> {
  const permissionHandle = handle as FileSystemDirectoryHandle & {
    queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
    requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  };
  if (await permissionHandle.queryPermission({ mode: "readwrite" }) === "granted") return true;
  return request && await permissionHandle.requestPermission({ mode: "readwrite" }) === "granted";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionPromise(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
