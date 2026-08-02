import type { JsonValue } from "../core/types";

export interface ChatGptSessionEnvelope {
  accessToken: string;
  expires: string;
  user?: { id?: string; email?: string; name?: string };
}

export interface ChatGptAccountRecord {
  account: {
    account_id: string;
    account_name?: string;
    account_plan?: string;
  };
  structure?: string;
  is_deactivated?: boolean;
}

export interface ChatGptAccountsEnvelope {
  accounts: Record<string, ChatGptAccountRecord>;
}

export interface ChatGptConversationListItem {
  id: string;
  title: string | null;
  create_time: number | null;
  update_time: number | null;
  mapping?: unknown;
  [key: string]: unknown;
}

export interface ChatGptConversationPage {
  items: ChatGptConversationListItem[];
  total: number | null;
  offset: number;
  limit: number;
  has_missing_conversations?: boolean;
  cursor?: string | null;
}

export interface ChatGptAuthor {
  role: string;
  name?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ChatGptMessageContent {
  content_type: string;
  parts?: unknown[];
  [key: string]: unknown;
}

export interface ChatGptMessage {
  id: string;
  author: ChatGptAuthor;
  create_time: number | null;
  update_time?: number | null;
  content: ChatGptMessageContent;
  status?: string;
  end_turn?: boolean | null;
  recipient?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChatGptMappingNode {
  id: string;
  message: ChatGptMessage | null;
  parent: string | null;
  children: string[];
  [key: string]: unknown;
}

export interface ChatGptConversationDetail {
  id?: string;
  conversation_id?: string;
  title: string | null;
  create_time: number | null;
  update_time: number | null;
  current_node: string | null;
  mapping: Record<string, ChatGptMappingNode>;
  [key: string]: unknown;
}

export function parseConversationPage(value: unknown): ChatGptConversationPage {
  const object = requireRecord(value, "conversation page");
  if (!Array.isArray(object.items)) throw new EnvelopeError("conversation page.items must be an array");
  const items = object.items.map((item, index) => parseConversationListItem(item, index));
  const total = nullableFiniteNumber(object.total, "conversation page.total");
  const offset = nonNegativeInteger(object.offset, "conversation page.offset");
  const limit = positiveInteger(object.limit, "conversation page.limit");
  const cursor = optionalNullableString(object.cursor, "conversation page.cursor");
  const missing = optionalBoolean(object.has_missing_conversations, "conversation page.has_missing_conversations");
  return {
    items,
    total,
    offset,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(missing !== undefined ? { has_missing_conversations: missing } : {}),
  };
}

export function parseConversationDetail(value: unknown): ChatGptConversationDetail {
  const object = requireRecord(value, "conversation detail");
  const mappingObject = requireRecord(object.mapping, "conversation detail.mapping");
  const mapping: Record<string, ChatGptMappingNode> = {};
  for (const [key, node] of Object.entries(mappingObject)) mapping[key] = parseMappingNode(node, key);
  const id = optionalString(object.id, "conversation detail.id");
  const conversationId = optionalString(object.conversation_id, "conversation detail.conversation_id");
  if (!id && !conversationId) throw new EnvelopeError("conversation detail requires id or conversation_id");
  return {
    ...object,
    ...(id ? { id } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    title: nullableString(object.title, "conversation detail.title"),
    create_time: nullableTimestamp(object.create_time, "conversation detail.create_time"),
    update_time: nullableTimestamp(object.update_time, "conversation detail.update_time"),
    current_node: nullableString(object.current_node, "conversation detail.current_node"),
    mapping,
  } as ChatGptConversationDetail;
}

export function parseAccountsEnvelope(value: unknown): ChatGptAccountsEnvelope {
  const object = requireRecord(value, "accounts envelope");
  const rawAccounts = requireRecord(object.accounts, "accounts envelope.accounts");
  const accounts: Record<string, ChatGptAccountRecord> = {};
  for (const [index, [key, value]] of Object.entries(rawAccounts).entries()) {
    const label = `accounts entry ${index}`;
    const record = requireRecord(value, label);
    const account = requireRecord(record.account, `${label}.account`);
    const accountName = optionalMetadataString(account.account_name, `${label}.account.account_name`)
      ?? optionalMetadataString(account.name, `${label}.account.name`);
    const accountPlan = optionalMetadataString(account.account_plan, `${label}.account.account_plan`)
      ?? optionalMetadataString(account.plan_type, `${label}.account.plan_type`);
    const structure = optionalMetadataString(record.structure, `${label}.structure`)
      ?? optionalMetadataString(account.structure, `${label}.account.structure`);
    const deactivated = optionalBoolean(record.is_deactivated, `${label}.is_deactivated`)
      ?? optionalBoolean(account.is_deactivated, `${label}.account.is_deactivated`);
    accounts[key] = {
      account: {
        account_id: requiredString(account.account_id, `${label}.account_id`),
        ...(accountName === undefined ? {} : { account_name: accountName }),
        ...(accountPlan === undefined ? {} : { account_plan: accountPlan }),
      },
      ...(structure === undefined ? {} : { structure }),
      ...(deactivated === undefined ? {} : { is_deactivated: deactivated }),
    };
  }
  return { accounts };
}

export function parseSessionEnvelopeInsidePage(value: unknown): ChatGptSessionEnvelope {
  const object = requireRecord(value, "session envelope");
  return {
    accessToken: requiredString(object.accessToken, "session envelope.accessToken"),
    expires: requiredString(object.expires, "session envelope.expires"),
  };
}

export class EnvelopeError extends Error {
  readonly code = "INVALID_CHATGPT_ENVELOPE";
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJsonValue(child)]));
  }
  throw new EnvelopeError(`value contains non-JSON type ${typeof value}`);
}

function parseConversationListItem(value: unknown, index: number): ChatGptConversationListItem {
  const object = requireRecord(value, `conversation page.items[${index}]`);
  return {
    ...object,
    id: requiredIdentifier(object.id, `conversation page.items[${index}].id`),
    title: nullableString(object.title, `conversation page.items[${index}].title`),
    create_time: nullableTimestamp(object.create_time, `conversation page.items[${index}].create_time`),
    update_time: nullableTimestamp(object.update_time, `conversation page.items[${index}].update_time`),
  };
}

function parseMappingNode(value: unknown, key: string): ChatGptMappingNode {
  const object = requireRecord(value, `mapping node ${key}`);
  const id = requiredIdentifier(object.id, `mapping node ${key}.id`);
  if (id !== key) throw new EnvelopeError(`mapping key ${key} does not match node id ${id}`);
  if (!Array.isArray(object.children) || !object.children.every((child) => typeof child === "string" && child.length > 0)) {
    throw new EnvelopeError(`mapping node ${key}.children must be string identifiers`);
  }
  const compactNullRoot = object.parent === undefined
    && object.message === undefined
    && Object.keys(object).every((field) => field === "id" || field === "children");
  return {
    ...object,
    id,
    parent: compactNullRoot ? null : nullableString(object.parent, `mapping node ${key}.parent`),
    children: [...object.children],
    message: compactNullRoot || object.message === null ? null : parseMessage(object.message, key),
  };
}

function parseMessage(value: unknown, nodeId: string): ChatGptMessage {
  const object = requireRecord(value, `mapping node ${nodeId}.message`);
  const author = requireRecord(object.author, `mapping node ${nodeId}.message.author`);
  const content = requireRecord(object.content, `mapping node ${nodeId}.message.content`);
  const updateTime = object.update_time === undefined
    ? undefined
    : nullableTimestamp(object.update_time, `mapping node ${nodeId}.message.update_time`);
  return {
    ...object,
    id: requiredIdentifier(object.id, `mapping node ${nodeId}.message.id`),
    author: { ...author, role: requiredString(author.role, `mapping node ${nodeId}.message.author.role`) },
    create_time: object.create_time === undefined
      ? null
      : nullableTimestamp(object.create_time, `mapping node ${nodeId}.message.create_time`),
    ...(updateTime === undefined ? {} : { update_time: updateTime }),
    content: { ...content, content_type: requiredString(content.content_type, `mapping node ${nodeId}.message.content.content_type`) },
  } as ChatGptMessage;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EnvelopeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new EnvelopeError(`${name} must be a non-empty string`);
  return value;
}

function requiredIdentifier(value: unknown, name: string): string {
  const identifier = requiredString(value, name);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(identifier)) throw new EnvelopeError(`${name} contains invalid characters`);
  return identifier;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function optionalMetadataString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, name);
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new EnvelopeError(`${name} must be a string or null`);
  return value;
}

function optionalNullableString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  return nullableString(value, name);
}

function nullableFiniteNumber(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new EnvelopeError(`${name} must be a finite number or null`);
  return value;
}

function nullableTimestamp(value: unknown, name: string): number | null {
  if (typeof value !== "string") return nullableFiniteNumber(value, name);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new EnvelopeError(`${name} must be a finite number, ISO-8601 string, or null`);
  return milliseconds / 1_000;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new EnvelopeError(`${name} must be a non-negative integer`);
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new EnvelopeError(`${name} must be a positive integer`);
  return value as number;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new EnvelopeError(`${name} must be a boolean`);
  return value;
}
