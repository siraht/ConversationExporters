export const providers = [
  "chatgpt-web",
  "claude-web",
  "gemini-web",
  "google-ai-studio",
  "grok-web",
] as const;

export type Provider = typeof providers[number];

export interface SyncConfig {
  archiveRoot: string;
  asmBinary: string;
  dataRoot: string;
  accountLabel: string;
  destination: string;
  rcloneBinary: string;
  driveRemote: string;
  drivePath: string;
}

export interface ImportResult {
  source: string;
  status: "imported" | "unchanged" | "unsupported";
  provider?: Provider;
  candidates: number;
  newVersions: number;
}

export interface SyncSummary {
  scanned: number;
  imported: number;
  unchanged: number;
  unsupported: number;
  candidates: number;
  newVersions: number;
  pushed: boolean;
  pushObjects: number;
  pushBytes: number;
}

export interface StateEntry {
  fingerprint: string;
  status: "imported" | "unsupported";
  provider?: Provider;
  checkedAt: string;
}

export interface SyncState {
  schema: "conversation-sync-state/1";
  sources: Record<string, StateEntry>;
}
