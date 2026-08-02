import type { WorkspaceSelection } from "../core/types";
import { parseAccountsEnvelope, parseConversationPage } from "./envelopes";
import type { ChatGptAccountRecord } from "./envelopes";
import type { ChatGptOperationParameters } from "./endpoints";
import type { ApiSuccessResponse } from "../extension/protocol";

export interface ChatGptTransport {
  request(operation: ChatGptOperationParameters, workspaceId: string | null, timeoutMs?: number): Promise<ApiSuccessResponse>;
}

export interface DiscoveredWorkspace extends WorkspaceSelection {
  deactivated: boolean;
}

export interface PreflightResult {
  ok: true;
  workspace: DiscoveredWorkspace;
  recognizedEmptyAccount: boolean;
  sampledConversationId: string | null;
}

export class ChatGptClient {
  constructor(private readonly transport: ChatGptTransport) {}

  async discoverWorkspaces(): Promise<DiscoveredWorkspace[]> {
    await this.transport.request({ operation: "session_probe", parameters: {} }, null);
    const response = await this.transport.request({ operation: "accounts_list", parameters: {} }, null);
    const envelope = parseAccountsEnvelope(response.body);
    const uniqueAccounts = new Map<string, (typeof envelope.accounts)[string]>();
    for (const record of Object.values(envelope.accounts)) {
      const existing = uniqueAccounts.get(record.account.account_id);
      if (!existing || accountRecordScore(record) > accountRecordScore(existing)) uniqueAccounts.set(record.account.account_id, record);
    }
    const workspaces = await Promise.all([...uniqueAccounts.values()].map(async (record, index) => {
      const accountId = record.account.account_id;
      const label = cleanLabel(record.account.account_name) ?? defaultLabel(record.structure, index);
      return {
        accountId,
        workspaceFingerprint: await workspaceFingerprint(accountId),
        label,
        kind: workspaceKind(record.structure, record.account.account_plan),
        deactivated: record.is_deactivated ?? false,
      } satisfies DiscoveredWorkspace;
    }));
    return workspaces.sort((left, right) => left.label.localeCompare(right.label) || left.workspaceFingerprint.localeCompare(right.workspaceFingerprint));
  }

  async preflight(workspace: DiscoveredWorkspace): Promise<PreflightResult> {
    if (workspace.deactivated) throw new PreflightError("SELECTED_WORKSPACE_DEACTIVATED", "The selected ChatGPT workspace is deactivated.");
    const current = await this.discoverWorkspaces();
    const verified = current.find((candidate) => candidate.accountId === workspace.accountId);
    if (!verified) throw new PreflightError("SELECTED_WORKSPACE_MISSING", "The selected ChatGPT workspace is no longer accessible.");
    if (verified.workspaceFingerprint !== workspace.workspaceFingerprint) {
      throw new PreflightError("WORKSPACE_FINGERPRINT_MISMATCH", "The selected ChatGPT workspace identity changed.");
    }
    const response = await this.transport.request({
      operation: "conversation_page",
      parameters: { offset: 0, limit: 1, archived: false },
    }, workspace.accountId);
    const page = parseConversationPage(response.body);
    const sampledConversationId = page.items[0]?.id ?? null;
    const recognizedEmptyAccount = page.items.length === 0 && page.total === 0;
    if (!sampledConversationId && !recognizedEmptyAccount) {
      throw new PreflightError("PREFLIGHT_INCONCLUSIVE", "ChatGPT returned neither one conversation nor a recognized empty account.");
    }
    return { ok: true, workspace: verified, recognizedEmptyAccount, sampledConversationId };
  }
}

function accountRecordScore(record: ChatGptAccountRecord): number {
  return Number(Boolean(record.account.account_name))
    + Number(Boolean(record.account.account_plan))
    + Number(Boolean(record.structure))
    + Number(record.is_deactivated !== undefined);
}

export async function workspaceFingerprint(accountId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`chatgpt-web-workspace-v1\0${accountId}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export class PreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

function cleanLabel(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean || null;
}

function defaultLabel(structure: string | undefined, index: number): string {
  const type = workspaceKind(structure, undefined);
  return `${type === "unknown" ? "ChatGPT" : capitalize(type)} workspace ${index + 1}`;
}

function workspaceKind(structure: string | undefined, plan: string | undefined): DiscoveredWorkspace["kind"] {
  const value = `${structure ?? ""} ${plan ?? ""}`.toLowerCase();
  if (value.includes("enterprise")) return "enterprise";
  if (value.includes("business") || value.includes("team")) return "business";
  if (value.includes("personal") || value.includes("plus") || value.includes("free") || value.includes("pro")) return "personal";
  return "unknown";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
