export type DirectProvider = "claude" | "gemini" | "ai-studio";
export type SyncProvider = "chatgpt" | "grok" | DirectProvider;
export type ArchiveNamespace = "chatgpt-web" | "claude-web" | "gemini-web" | "google-ai-studio" | "grok-web";

export interface SyncSummary {
  provider: SyncProvider;
  discovered: number;
  fetched: number;
  unchanged: number;
  retained: number;
  failed: number;
}

export interface StorageSettings {
  vpsEnabled: boolean;
  vpsBaseUrl: string;
  vpsToken: string;
  nativeEnabled: boolean;
}

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  vpsEnabled: false,
  vpsBaseUrl: "",
  vpsToken: "",
  nativeEnabled: false,
};
