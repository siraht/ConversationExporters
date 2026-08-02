import { createDirectoryHandleStore } from "@conversation-exporters/shared/handle-store";

const store = createDirectoryHandleStore("chatgpt-exporter");

export const saveDirectoryHandle = store.save;
export const loadDirectoryHandle = store.load;
export const ensureDirectoryPermission = store.ensurePermission;
