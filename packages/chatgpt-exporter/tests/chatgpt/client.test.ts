import { describe, expect, it, vi } from "vitest";

import { ChatGptClient, PreflightError, workspaceFingerprint, type ChatGptTransport } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import { BRIDGE_PROTOCOL_VERSION, type ApiSuccessResponse } from "../../src/extension/protocol";
import type { JsonValue } from "../../src/core/types";

describe("ChatGPT account discovery and preflight", () => {
  it("discovers sanitized workspaces with stable non-reversible directory fingerprints", async () => {
    const transport = fixtureTransport();
    const workspaces = await new ChatGptClient(transport).discoverWorkspaces();
    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]).toMatchObject({ label: "Business workspace", kind: "business", deactivated: false });
    expect(workspaces[0]?.workspaceFingerprint).toMatch(/^[a-f0-9]{32}$/);
    expect(workspaces[0]?.workspaceFingerprint).not.toContain("account-business");
    expect(await workspaceFingerprint("account-business")).toBe(workspaces[0]?.workspaceFingerprint);
  });

  it("deduplicates live account aliases and reads nested account metadata", async () => {
    const transport = fixtureTransport({}, {
      first: {
        account: { account_id: "account-personal", name: "Personal workspace", plan_type: "plus", structure: "personal", is_deactivated: false },
      },
      alias: {
        account: { account_id: "account-personal", name: null, plan_type: null, structure: null, is_deactivated: false },
      },
    });

    expect(await new ChatGptClient(transport).discoverWorkspaces()).toMatchObject([
      { label: "Personal workspace", kind: "personal", deactivated: false },
    ]);
  });

  it("preflights an explicitly selected workspace against one conversation", async () => {
    const transport = fixtureTransport();
    const client = new ChatGptClient(transport);
    const workspace = (await client.discoverWorkspaces())[0]!;
    expect(await client.preflight(workspace)).toMatchObject({
      ok: true,
      recognizedEmptyAccount: false,
      sampledConversationId: "conversation-1",
    });
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ operation: "conversation_page" }), "account-business");
  });

  it("accepts only an explicitly declared empty account", async () => {
    const transport = fixtureTransport({ items: [], total: null });
    const client = new ChatGptClient(transport);
    const workspace = (await client.discoverWorkspaces())[0]!;
    await expect(client.preflight(workspace)).rejects.toBeInstanceOf(PreflightError);

    const emptyClient = new ChatGptClient(fixtureTransport({ items: [], total: 0 }));
    const emptyWorkspace = (await emptyClient.discoverWorkspaces())[0]!;
    expect((await emptyClient.preflight(emptyWorkspace)).recognizedEmptyAccount).toBe(true);
  });

  it("accepts ISO-8601 timestamps from the live conversation listing envelope", async () => {
    const transport = fixtureTransport({
      items: [{
        id: "conversation-1",
        title: "Synthetic",
        create_time: "2026-08-01T12:00:00.000000+00:00",
        update_time: "2026-08-01T12:01:30.000000+00:00",
      }],
    });
    const client = new ChatGptClient(transport);
    const workspace = (await client.discoverWorkspaces())[0]!;

    expect((await client.preflight(workspace)).sampledConversationId).toBe("conversation-1");
  });
});

function fixtureTransport(
  pageOverrides: Record<string, JsonValue> = {},
  accountOverrides?: Record<string, JsonValue>,
): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    let body: JsonValue;
    if (operation.operation === "session_probe") {
      body = { authenticated: true, expiresAt: "2099-01-01T00:00:00.000Z" };
    } else if (operation.operation === "accounts_list") {
      body = {
        accounts: accountOverrides ?? {
          business: {
            account: { account_id: "account-business", account_name: "Business\u0000 workspace", account_plan: "business" },
            structure: "workspace",
          },
          personal: {
            account: { account_id: "account-personal", account_name: "Personal", account_plan: "plus" },
            structure: "personal",
          },
        },
      };
    } else {
      body = {
        items: [{ id: "conversation-1", title: "Synthetic", create_time: 1, update_time: 2 }],
        total: 1,
        offset: 0,
        limit: 1,
        ...pageOverrides,
      };
    }
    return {
      requestId: "request-1",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: true,
      status: 200,
      body,
      responseBytes: JSON.stringify(body).length,
      correlationId: "correlation-1",
    };
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}
