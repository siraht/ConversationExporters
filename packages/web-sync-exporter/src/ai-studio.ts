type JsonArray = unknown[];

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: JsonArray;
}

let captured: CapturedRequest | undefined;
let originalFetch: typeof window.fetch | undefined;

export function installAiStudioCapture(): void {
  if (location.hostname !== "aistudio.google.com") return;
  originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const capture = captureRequest(input, init);
    const response = await originalFetch!(input, init);
    const request = await capture;
    if (request) {
      captured = request;
    }
    return response;
  };
}

export async function listAiStudioPrompts(): Promise<unknown[][]> {
  if (location.hostname !== "aistudio.google.com") throw new Error("wrong provider tab");
  const template = captured;
  if (!originalFetch) throw new Error("AI Studio page bridge is unavailable");
  if (!template) throw new Error("AI Studio prompt inventory is not initialized. Open or refresh AI Studio's prompt history, then retry.");
  const output = new Map<string, unknown[]>();
  let cursor: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const body = [...template.body];
    body[0] = 100;
    body[1] = cursor;
    const response = await requestPage(template, body);
    const parsed = parsePromptPage(response);
    for (const prompt of parsed.prompts) output.set(promptIdentity(prompt), prompt);
    if (!parsed.cursor || parsed.cursor === cursor) break;
    cursor = parsed.cursor;
  }
  if (!output.size) throw new Error("AI Studio returned no saved prompts");
  return [...output.values()];
}

export function parsePromptPage(value: unknown): { prompts: unknown[][]; cursor: string | null } {
  if (!Array.isArray(value)) throw new Error("AI Studio prompt inventory was malformed");
  const prompts = Array.isArray(value[0])
    ? value[0].filter((item): item is unknown[] => Array.isArray(item) && typeof item[0] === "string")
    : [];
  return { prompts, cursor: typeof value[1] === "string" && value[1] ? value[1] : null };
}

export function promptIdentity(prompt: unknown[]): string {
  const name = prompt[0];
  if (typeof name !== "string" || !name) throw new Error("AI Studio prompt lacks a provider identity");
  return name;
}

async function captureRequest(input: RequestInfo | URL, init?: RequestInit): Promise<CapturedRequest | undefined> {
  const request = input instanceof Request ? input : undefined;
  const url = request?.url ?? String(input);
  if (!url.includes("/MakerSuiteService/ListPrompts")) return undefined;
  const bodyText = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : undefined;
  if (!bodyText) return undefined;
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { return undefined; }
  if (!Array.isArray(body)) return undefined;
  const headers = new Headers(request?.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return {
    url,
    body,
    init: { method: init?.method ?? request?.method ?? "POST", headers, credentials: "include" },
  };
}

async function requestPage(template: CapturedRequest, body: JsonArray): Promise<unknown> {
  if (!originalFetch) throw new Error("AI Studio page bridge is unavailable");
  const response = await originalFetch(template.url, { ...template.init, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`AI Studio inventory failed (${response.status})`);
  return await response.json();
}
