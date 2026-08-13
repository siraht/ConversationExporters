export type Provider = "claude" | "gemini" | "ai-studio";
export type PageOperation =
  | "claudeList"
  | "claudeDetail"
  | "claudeAccount"
  | "claudeProjects"
  | "claudeProjectDetail"
  | "claudeProjectDocs"
  | "claudeProjectConversations"
  | "claudeFile"
  | "geminiList"
  | "geminiDetail"
  | "geminiGems"
  | "geminiAsset"
  | "geminiAccount"
  | "geminiExtract"
  | "aiStudioList"
  | "aiStudioInventory"
  | "aiStudioDetail"
  | "aiStudioAsset";
export interface PageRequest { type: "WEB_SYNC_PAGE_REQUEST_V2"; requestId: string; operation: PageOperation; parameters?: Record<string, unknown> }
export interface PageReply { requestId: string; ok: boolean; result?: unknown; error?: string }
export interface SyncSummary { provider: Provider; discovered: number; fetched: number; unchanged: number; retained: number; failed: number }

export function safeToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{4,200}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
