import { describe, expect, it } from "vitest";

import {
  EnvelopeError,
  parseAccountsEnvelope,
  parseConversationDetail,
  parseConversationPage,
  parseSessionEnvelopeInsidePage,
  toJsonValue,
} from "../../src/chatgpt/envelopes";
import { conversationDetail, conversationPage } from "../fixtures/chatgpt";

describe("ChatGPT provider envelopes", () => {
  it("accepts a synthetic listing page and preserves provider fields", () => {
    const page = parseConversationPage(conversationPage({ cursor: null }));
    expect(page.items[0]?.id).toBe("conversation-1");
    expect(page.cursor).toBeNull();
  });

  it("rejects listing pages whose pagination evidence is malformed", () => {
    expect(() => parseConversationPage({ ...conversationPage(), limit: 0 })).toThrow(EnvelopeError);
    expect(() => parseConversationPage({ ...conversationPage(), total: "1" })).toThrow("conversation page.total");
  });

  it("accepts a complete graph and rejects mapping key drift", () => {
    expect(Object.keys(parseConversationDetail(conversationDetail()).mapping)).toHaveLength(3);
    const detail = conversationDetail();
    detail.mapping["user-1"] = { ...detail.mapping["user-1"]!, id: "different-node" };
    expect(() => parseConversationDetail(detail)).toThrow("does not match node id");
  });

  it("expands the live compact null-root node without tolerating other omissions", () => {
    const compact = conversationDetail() as unknown as { mapping: Record<string, Record<string, unknown>> };
    delete compact.mapping["root-1"]!.parent;
    delete compact.mapping["root-1"]!.message;
    expect(parseConversationDetail(compact).mapping["root-1"]).toMatchObject({ parent: null, message: null });

    const malformed = conversationDetail() as unknown as { mapping: Record<string, Record<string, unknown>> };
    delete malformed.mapping["user-1"]!.message;
    expect(() => parseConversationDetail(malformed)).toThrow("message must be an object");
  });

  it("normalizes live batch timestamps and omitted message timestamps", () => {
    const detail = conversationDetail() as unknown as {
      create_time: unknown;
      update_time: unknown;
      mapping: Record<string, { message: Record<string, unknown> | null }>;
    };
    detail.create_time = "2026-08-01T12:00:00.000Z";
    detail.update_time = "2026-08-01T12:00:01.500Z";
    detail.mapping["user-1"]!.message!.create_time = "2026-08-01T12:00:02.250Z";
    delete detail.mapping["assistant-1"]!.message!.create_time;

    const parsed = parseConversationDetail(detail);
    expect(parsed.create_time).toBe(1_785_585_600);
    expect(parsed.update_time).toBe(1_785_585_601.5);
    expect(parsed.mapping["user-1"]!.message!.create_time).toBe(1_785_585_602.25);
    expect(parsed.mapping["assistant-1"]!.message!.create_time).toBeNull();
  });

  it("rejects malformed detail timestamps", () => {
    const invalidRoot = { ...conversationDetail(), create_time: "yesterday" };
    expect(() => parseConversationDetail(invalidRoot)).toThrow("conversation detail.create_time");
    const detail = conversationDetail() as unknown as { mapping: Record<string, { message: Record<string, unknown> | null }> };
    detail.mapping["user-1"]!.message!.create_time = "eventually";
    expect(() => parseConversationDetail(detail)).toThrow("message.create_time");
  });

  it("validates sanitized account metadata", () => {
    expect(parseAccountsEnvelope({
      accounts: {
        internal_key: {
          account: { account_id: "account-1", account_name: "Personal", account_plan: "free" },
          structure: "personal",
          is_deactivated: false,
        },
      },
    }).accounts.internal_key?.account.account_id).toBe("account-1");
  });

  it("redacts account map keys from validation errors", () => {
    const parse = () => parseAccountsEnvelope({ accounts: { "private-account-key": { account: { account_id: null } } } });
    expect(parse).toThrowError(/accounts entry 0\.account_id/);
    expect(parse).not.toThrowError(/private-account-key/);
  });

  it("parses session secrets only through an explicitly page-local function", () => {
    expect(parseSessionEnvelopeInsidePage({ accessToken: "synthetic-token", expires: "2099-01-01T00:00:00Z" }).expires)
      .toBe("2099-01-01T00:00:00Z");
    expect(() => parseSessionEnvelopeInsidePage({ expires: "2099-01-01T00:00:00Z" })).toThrow("accessToken");
  });

  it("rejects values that cannot be serialized as JSON evidence", () => {
    expect(toJsonValue({ nested: [1, true, null] })).toEqual({ nested: [1, true, null] });
    expect(() => toJsonValue({ secret: undefined })).toThrow("non-JSON type undefined");
  });
});
