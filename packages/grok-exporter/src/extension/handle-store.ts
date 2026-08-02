import { createDirectoryHandleStore } from "@conversation-exporters/shared/handle-store";

const store = createDirectoryHandleStore("grok-exporter");

export const saveDirectoryHandle = store.save;
export const loadDirectoryHandle = store.load;
export const ensureDirectoryPermission = store.ensurePermission;
