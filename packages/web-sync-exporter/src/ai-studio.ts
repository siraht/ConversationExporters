type JsonMessage = unknown[] | Record<string, unknown>;

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: JsonMessage;
}

export interface AiStudioPromptRecord { id: string; inventory: unknown[]; detail: unknown }
export interface PromptReferenceLocator { path: Array<number | string>; prefix: string; suffix: string }
let capturedList: CapturedRequest | undefined;
let capturedGet: CapturedRequest | undefined;
let originalFetch: typeof window.fetch | undefined;
const xhrStates = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Headers }>();
const captureChannel = "conversation-exporters:ai-studio-rpc-template";

export function installAiStudioCapture(): void {
  if (location.hostname !== "aistudio.google.com") return;
  originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const capture = captureRequest(input, init);
    const response = await originalFetch!(input, init);
    const request = await capture;
    remember(request);
    return response;
  };
  window.addEventListener("message", receiveFrameCapture);
  installXhrCapture();
}

export async function listAiStudioPrompts(): Promise<AiStudioPromptRecord[]> {
  if (location.hostname !== "aistudio.google.com") throw new Error("wrong provider tab");
  const listTemplate = capturedList;
  const getTemplate = capturedGet;
  if (!originalFetch) throw new Error("AI Studio page bridge is unavailable");
  if (!listTemplate) throw new Error("AI Studio prompt inventory is not initialized. Open or refresh AI Studio's prompt history, then retry.");
  if (!getTemplate) throw new Error("AI Studio prompt detail is not initialized. Open one saved prompt after refreshing AI Studio, then retry.");
  const output = new Map<string, unknown[]>();
  let cursor: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const body = withMessageFields(listTemplate.body, { 0: 100, 1: cursor });
    const response = await requestPage(listTemplate, body, "inventory");
    const parsed = parsePromptPage(response);
    for (const prompt of parsed.prompts) output.set(promptIdentity(prompt), prompt);
    if (!parsed.cursor || parsed.cursor === cursor) break;
    cursor = parsed.cursor;
  }
  if (!output.size) throw new Error("AI Studio returned no saved prompts");
  const inventories = [...output.values()];
  const reference = messageField(getTemplate.body, 0);
  const locator = getTemplate.url.includes("MakerSuiteService/ResolveDriveResource") && typeof reference === "string"
    ? locatePromptReference(inventories, reference)
    : null;
  if (getTemplate.url.includes("MakerSuiteService/ResolveDriveResource") && !locator) {
    throw new Error("AI Studio could not match the opened prompt to its inventory record. Refresh prompt history, open a saved prompt from that list, then retry.");
  }
  const records: AiStudioPromptRecord[] = [];
  for (const inventory of inventories) {
    const id = promptIdentity(inventory);
    const detailReference = locator ? promptReferenceAt(inventory, locator) : id;
    if (!detailReference) throw new Error(`AI Studio prompt ${id} lacks the expected Drive reference`);
    const detail = await requestPage(getTemplate, promptRequestBody(getTemplate.body, detailReference), "prompt detail");
    records.push({ id, inventory, detail });
  }
  return records;
}

export function promptRequestBody(template: JsonMessage, id: string): JsonMessage {
  return withMessageFields(template, { 0: id });
}

export function parsePromptPage(value: unknown): { prompts: unknown[][]; cursor: string | null } {
  if (!isJsonMessage(value)) throw new Error("AI Studio prompt inventory was malformed");
  const promptValue = messageField(value, 0);
  const cursorValue = messageField(value, 1);
  const prompts = Array.isArray(promptValue)
    ? promptValue.filter((item): item is unknown[] => Array.isArray(item) && typeof item[0] === "string")
    : [];
  return { prompts, cursor: typeof cursorValue === "string" && cursorValue ? cursorValue : null };
}

export function promptIdentity(prompt: unknown[]): string {
  const name = prompt[0];
  if (typeof name !== "string" || !name) throw new Error("AI Studio prompt lacks a provider identity");
  return name;
}

export function locatePromptReference(records: unknown[][], reference: string): PromptReferenceLocator | null {
  for (const record of records) {
    const match = findStringContaining(record, reference);
    if (match) return {
      path: match.path,
      prefix: match.value.slice(0, match.value.indexOf(reference)),
      suffix: match.value.slice(match.value.indexOf(reference) + reference.length),
    };
  }
  return null;
}

export function promptReferenceAt(record: unknown[], locator: PromptReferenceLocator): string | null {
  let value: unknown = record;
  for (const part of locator.path) {
    if (Array.isArray(value) && typeof part === "number") value = value[part];
    else if (value && typeof value === "object") value = (value as Record<string, unknown>)[String(part)];
    else return null;
  }
  if (typeof value !== "string" || !value.startsWith(locator.prefix) || !value.endsWith(locator.suffix)) return null;
  const end = locator.suffix ? -locator.suffix.length : undefined;
  const reference = value.slice(locator.prefix.length, end);
  return reference || null;
}

export function promptRpcKind(url: string): "list" | "get" | undefined {
  if (url.includes("MakerSuiteService/ListPrompts")) return "list";
  if (url.includes("MakerSuiteService/GetPrompt") || url.includes("MakerSuiteService/ResolveDriveResource")) return "get";
  return undefined;
}

async function captureRequest(input: RequestInfo | URL, init?: RequestInit): Promise<CapturedRequest | undefined> {
  const request = input instanceof Request ? input : undefined;
  const url = request?.url ?? String(input);
  if (!promptRpcKind(url)) return undefined;
  const bodyText = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : undefined;
  if (!bodyText) return undefined;
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { return undefined; }
  if (!isJsonMessage(body)) return undefined;
  const headers = new Headers(request?.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return {
    url,
    body,
    init: { method: init?.method ?? request?.method ?? "POST", headers, credentials: "include" },
  };
}

function installXhrCapture(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async = true, username?: string | null, password?: string | null): void {
    xhrStates.set(this, { method, url: String(url), headers: new Headers() });
    Reflect.apply(originalOpen, this, [method, url, async, username, password]);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name: string, value: string): void {
    xhrStates.get(this)?.headers.append(name, value);
    originalHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null): void {
    const state = xhrStates.get(this);
    if (state && typeof body === "string") remember(capturedFromBody(state.url, state.method, state.headers, body));
    originalSend.call(this, body);
  };
}

function capturedFromBody(url: string, method: string, headers: Headers, bodyText: string): CapturedRequest | undefined {
  if (!promptRpcKind(url)) return undefined;
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { return undefined; }
  if (!isJsonMessage(body)) return undefined;
  return { url, body, init: { method: method || "POST", headers, credentials: "include" } };
}

function remember(request: CapturedRequest | undefined): void {
  const kind = request ? promptRpcKind(request.url) : undefined;
  if (kind === "list") capturedList = request;
  if (kind === "get") capturedGet = request;
  if (request && window !== window.top) {
    const headers = [...new Headers(request.init.headers).entries()];
    window.top?.postMessage({ channel: captureChannel, template: { url: request.url, method: request.init.method, headers, body: request.body } }, location.origin);
  }
}

function receiveFrameCapture(event: MessageEvent): void {
  if (window !== window.top || event.origin !== location.origin) return;
  const data = event.data as { channel?: unknown; template?: unknown } | null;
  if (data?.channel !== captureChannel || !data.template || typeof data.template !== "object") return;
  const value = data.template as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
  if (typeof value.url !== "string" || !promptRpcKind(value.url) || !isJsonMessage(value.body) || !Array.isArray(value.headers)) return;
  const headers = new Headers();
  for (const pair of value.headers) if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") headers.append(pair[0], pair[1]);
  remember({ url: value.url, body: value.body, init: { method: typeof value.method === "string" ? value.method : "POST", headers, credentials: "include" } });
}

async function requestPage(template: CapturedRequest, body: JsonMessage, label: string): Promise<unknown> {
  if (!originalFetch) throw new Error("AI Studio page bridge is unavailable");
  const response = await originalFetch(template.url, { ...template.init, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`AI Studio ${label} failed (${response.status})`);
  return await response.json();
}

function isJsonMessage(value: unknown): value is JsonMessage {
  return Array.isArray(value) || (typeof value === "object" && value !== null);
}

function messageField(message: JsonMessage, field: number): unknown {
  return Array.isArray(message) ? message[field] : message[String(field)];
}

function findStringContaining(value: unknown, needle: string, path: Array<number | string> = []): { path: Array<number | string>; value: string } | null {
  if (typeof value === "string") return value.includes(needle) ? { path, value } : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = findStringContaining(value[index], needle, [...path, index]);
      if (match) return match;
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const match = findStringContaining(child, needle, [...path, key]);
      if (match) return match;
    }
  }
  return null;
}

function withMessageFields(message: JsonMessage, fields: Record<number, unknown>): JsonMessage {
  const copy: JsonMessage = Array.isArray(message) ? [...message] : { ...message };
  for (const [field, value] of Object.entries(fields)) {
    if (Array.isArray(copy)) copy[Number(field)] = value;
    else copy[field] = value;
  }
  return copy;
}
