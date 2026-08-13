import { safeToken, type PageReply, type PageRequest } from "./protocol";
import { parseGeminiChatResponse, parseGeminiResponse, rpcPayload } from "./gemini";
import { getAiStudioPromptDetail, installAiStudioCapture, listAiStudioPromptInventory, listAiStudioPrompts } from "./ai-studio";

const requestChannel = "conversation-sync:page-request:v2";
const responseChannel = "conversation-sync:page-response:v2";
const assetTransfers = new Map<string, Uint8Array>();

installAiStudioCapture();

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { channel?: string; request?: PageRequest } | undefined;
  if (event.source !== window || event.origin !== location.origin || data?.channel !== requestChannel || !data.request) return;
  void execute(data.request).then((reply) => window.postMessage({ channel: responseChannel, reply }, location.origin));
});

async function execute(request: PageRequest): Promise<PageReply> {
  try {
    const result = request.operation === "claudeList" ? await claudeList()
      : request.operation === "claudeDetail" ? await claudeDetail(request.parameters)
      : request.operation === "claudeAccount" ? await claudeAccount()
      : request.operation === "claudeProjects" ? await claudeProjects(request.parameters)
      : request.operation === "claudeProjectDetail" ? await claudeProjectResource(request.parameters, "detail")
      : request.operation === "claudeProjectDocs" ? await claudeProjectResource(request.parameters, "docs")
      : request.operation === "claudeProjectConversations" ? await claudeProjectResource(request.parameters, "conversations")
      : request.operation === "claudeFile" ? await claudeFile(request.parameters)
        : request.operation === "geminiList" ? await geminiList()
          : request.operation === "geminiDetail" ? await geminiDetail(request.parameters)
          : request.operation === "geminiGems" ? await geminiGems()
          : request.operation === "geminiAsset" ? await providerAsset(request.parameters, ["googleusercontent.com", "googleapis.com"])
          : request.operation === "geminiAccount" ? await geminiAccount()
          : request.operation === "geminiExtract" ? geminiExtract()
            : request.operation === "aiStudioList" ? await listAiStudioPrompts()
            : request.operation === "aiStudioInventory" ? await listAiStudioPromptInventory()
            : request.operation === "aiStudioDetail" ? await getAiStudioPromptDetail(request.parameters?.inventory)
            : request.operation === "aiStudioAsset" ? await aiStudioAsset(request.parameters)
            : (() => { throw new Error("unsupported page operation"); })();
    return { requestId: request.requestId, ok: true, result };
  } catch (error) {
    return { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : "provider request failed" };
  }
}

async function claudeList(): Promise<Record<string, unknown>[]> {
  if (location.hostname !== "claude.ai") throw new Error("wrong provider tab");
  const organizationsResponse = await fetch("/api/organizations", { credentials: "include" });
  if (!organizationsResponse.ok) throw new Error(`Claude authentication failed (${organizationsResponse.status})`);
  const organizations = await organizationsResponse.json() as Array<{ uuid?: string }>;
  const output: Record<string, unknown>[] = [];
  for (const organization of organizations) {
    if (!organization.uuid) continue;
    const response = await fetch(`/api/organizations/${encodeURIComponent(organization.uuid)}/chat_conversations`, { credentials: "include" });
    if (!response.ok) continue;
    const rows: unknown = await response.json();
    if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === "object") output.push({ ...row, _organization_uuid: organization.uuid });
  }
  if (!output.length) throw new Error("Claude returned no conversation inventory");
  return output;
}

async function claudeAccount(): Promise<unknown> {
  requireHost("claude.ai");
  return await fetchJson("/api/organizations", "Claude account inventory");
}

async function claudeProjects(parameters: Record<string, unknown> | undefined): Promise<unknown> {
  requireHost("claude.ai");
  const organizationId = safeToken(parameters?.organizationId, "organization ID");
  return await fetchJson(`/api/organizations/${encodeURIComponent(organizationId)}/projects`, "Claude project inventory");
}

async function claudeProjectResource(parameters: Record<string, unknown> | undefined, kind: "detail" | "docs" | "conversations"): Promise<unknown> {
  requireHost("claude.ai");
  const organizationId = safeToken(parameters?.organizationId, "organization ID");
  const projectId = safeToken(parameters?.projectId, "project ID");
  const suffix = kind === "detail" ? "" : kind === "docs" ? "/docs?tree=true" : "/conversations?tree=true";
  return await fetchJson(`/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}${suffix}`, `Claude project ${kind}`);
}

async function claudeFile(parameters: Record<string, unknown> | undefined): Promise<unknown> {
  requireHost("claude.ai");
  const phaseResult = transferPhase(parameters); if (phaseResult) return phaseResult;
  const organizationId = safeToken(parameters?.organizationId, "organization ID");
  const conversationId = safeToken(parameters?.conversationId, "conversation ID");
  const fileUuid = typeof parameters?.fileUuid === "string" ? safeToken(parameters.fileUuid, "file UUID") : undefined;
  const sandboxPath = typeof parameters?.sandboxPath === "string" ? parameters.sandboxPath : undefined;
  const previewUrl = typeof parameters?.previewUrl === "string" && parameters.previewUrl.startsWith(`/api/${organizationId}/files/`) ? parameters.previewUrl : undefined;
  if (!fileUuid && (!sandboxPath || !sandboxPath.startsWith("/mnt/"))) throw new Error("Claude file lacks a supported provider reference");
  if (fileUuid) return await fetchBinaryFallback([
    { url: `/api/organizations/${encodeURIComponent(organizationId)}/files/${encodeURIComponent(fileUuid)}/contents`, variant: "original" },
    { url: previewUrl ?? `/api/${encodeURIComponent(organizationId)}/files/${encodeURIComponent(fileUuid)}/preview`, variant: "preview" },
  ], "Claude image");
  return await fetchBinary(`/api/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/wiggle/download-file?path=${encodeURIComponent(sandboxPath!)}`, "Claude file");
}

async function claudeDetail(parameters: Record<string, unknown> | undefined): Promise<unknown> {
  const organizationId = safeToken(parameters?.organizationId, "organization ID");
  const conversationId = safeToken(parameters?.conversationId, "conversation ID");
  const url = `/api/organizations/${encodeURIComponent(organizationId)}/chat_conversations/${encodeURIComponent(conversationId)}?tree=True&rendering_mode=messages&render_all_tools=true`;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Claude conversation request failed (${response.status})`);
  return await response.json();
}

async function geminiList(): Promise<Array<{ id: string; title: string; updated_at: string | null }>> {
  if (location.hostname !== "gemini.google.com") throw new Error("wrong provider tab");
  const session = geminiSession();
  const output = new Map<string, { id: string; title: string; updated_at: string | null }>();
  let cursor: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const argument = cursor === null ? [13, null, [0, null, 1]] : [20, cursor, [0, null, 1]];
    const request = JSON.stringify([[['MaZiqc', JSON.stringify(argument), null, 'generic']]]);
    const url = `/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&source-path=%2Fapp&bl=${encodeURIComponent(session.bl)}&f.sid=${encodeURIComponent(session.sid)}&hl=en&_reqid=${Math.floor(Math.random() * 900000) + 100000}&rt=c`;
    const response = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" }, body: `f.req=${encodeURIComponent(request)}&at=${encodeURIComponent(session.at)}` });
    if (!response.ok) throw new Error(`Gemini inventory failed (${response.status})`);
    const parsed = parseGeminiResponse(await response.text());
    for (const item of parsed.items) if (!output.has(item.id)) output.set(item.id, item);
    if (!parsed.cursor || parsed.cursor === cursor) break;
    cursor = parsed.cursor;
  }
  return [...output.values()];
}

async function geminiDetail(parameters: Record<string, unknown> | undefined): Promise<unknown> {
  const conversationId = safeToken(parameters?.conversationId, "conversation ID").replace(/^c_/, "");
  const limit = 1_000;
  const session = geminiSession();
  const payload = [`c_${conversationId}`, limit, null, 1, [1], [4], null, 1];
  const request = JSON.stringify([[['hNvQHb', JSON.stringify(payload), null, 'generic']]]);
  const url = `/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp&bl=${encodeURIComponent(session.bl)}&f.sid=${encodeURIComponent(session.sid)}&hl=en&_reqid=${Math.floor(Math.random() * 900000) + 100000}&rt=c`;
  const response = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" }, body: `f.req=${encodeURIComponent(request)}&at=${encodeURIComponent(session.at)}` });
  if (!response.ok) throw new Error(`Gemini conversation request failed (${response.status})`);
  const result = parseGeminiChatResponse(await response.text(), conversationId, limit);
  if (!result.messages.length) throw new Error("Gemini conversation response contained no messages");
  return result;
}

async function geminiGems(): Promise<unknown> {
  requireHost("gemini.google.com");
  const listText = await geminiRpc("CNgdBe", [2, ["en"], false]);
  const list = rpcPayload(listText, "CNgdBe");
  const rows = Array.isArray(list?.[2]) ? list[2] : [];
  const records: Array<{ id: string; inventory: unknown; detail: unknown }> = [];
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !row[0]) continue;
    const id = row[0];
    const detailText = await geminiRpc("HcT8bb", [id, ["en"], true, null, true]);
    records.push({ id, inventory: row, detail: rpcPayload(detailText, "HcT8bb") ?? detailText });
  }
  return { provider_raw: list ?? listText, gems: records };
}

async function geminiAccount(): Promise<unknown> {
  requireHost("gemini.google.com");
  const results: Record<string, unknown> = {};
  for (const [name, rpcId, payload] of [
    ["user_status", "otAQ7b", []],
    ["user_preferences", "ESY5D", []],
    ["managed_skills", "cCSu7", []],
  ] as const) {
    try {
      const text = await geminiRpc(rpcId, payload);
      results[name] = rpcPayload(text, rpcId) ?? text;
    } catch (error) {
      results[name] = { error: error instanceof Error ? error.message : "request failed" };
    }
  }
  return results;
}

async function geminiRpc(rpcId: string, payload: readonly unknown[]): Promise<string> {
  if (!/^[A-Za-z0-9]{6}$/.test(rpcId)) throw new Error("invalid Gemini RPC ID");
  const session = geminiSession();
  const request = JSON.stringify([[[rpcId, JSON.stringify(payload), null, "generic"]]]);
  const url = `/_/BardChatUi/data/batchexecute?rpcids=${rpcId}&source-path=%2Fapp&bl=${encodeURIComponent(session.bl)}&f.sid=${encodeURIComponent(session.sid)}&hl=en&_reqid=${Math.floor(Math.random() * 900000) + 100000}&rt=c`;
  const response = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "X-Same-Domain": "1" }, body: `f.req=${encodeURIComponent(request)}&at=${encodeURIComponent(session.at)}` });
  if (!response.ok) throw new Error(`Gemini ${rpcId} request failed (${response.status})`);
  return await response.text();
}

function geminiSession(): { sid: string; bl: string; at: string } {
  const wiz = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data ?? {};
  const session = { sid: String(wiz.FdrFJe ?? ""), bl: String(wiz.cfb2h ?? ""), at: String(wiz.SNlM0e ?? "") };
  if (!session.sid || !session.bl || !session.at) throw new Error("Gemini authentication parameters are unavailable");
  return session;
}

function geminiExtract(): { messages: Array<{ id: string; role: "user" | "assistant"; content: string }> } {
  const conversationId = location.pathname.split("/").filter(Boolean).at(-1) ?? "conversation";
  const pairs = [
    ...Array.from(document.querySelectorAll("user-query, [data-role='user'], .user-query-container")).map((element) => ({ element, role: "user" as const })),
    ...Array.from(document.querySelectorAll("model-response, [data-role='model'], .model-response-text")).map((element) => ({ element, role: "assistant" as const })),
  ].sort((left, right) => left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  return { messages: pairs.flatMap(({ element, role }, index) => element.textContent?.trim() ? [{ id: `${conversationId}-${index}`, role, content: element.textContent.trim() }] : []) };
}

async function aiStudioAsset(parameters: Record<string, unknown> | undefined): Promise<unknown> {
  requireHost("aistudio.google.com");
  const phaseResult = transferPhase(parameters); if (phaseResult) return phaseResult;
  const driveId = typeof parameters?.driveId === "string" ? safeToken(parameters.driveId, "Drive file ID") : undefined;
  const url = typeof parameters?.url === "string" ? parameters.url : undefined;
  if (url) return await providerAsset({ url }, ["googleusercontent.com", "googleapis.com"]);
  if (!driveId) throw new Error("AI Studio asset lacks a Drive file ID");
  return await fetchBinary(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`, "AI Studio Drive asset");
}

async function providerAsset(parameters: Record<string, unknown> | undefined, allowedSuffixes: string[]): Promise<unknown> {
  const phaseResult = transferPhase(parameters); if (phaseResult) return phaseResult;
  const raw = typeof parameters?.url === "string" ? parameters.url : "";
  const url = new URL(raw);
  if (url.protocol !== "https:" || !allowedSuffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) throw new Error("provider asset URL is not allowed");
  return await fetchBinary(url.href, "Provider asset");
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${label} failed (${response.status})`);
  return await response.json();
}

async function fetchBinary(url: string, label: string, variant = "provider"): Promise<{ transferId: string; contentType: string; contentDisposition: string; size: number; variant: string }> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`${label} failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const transferId = crypto.randomUUID(); assetTransfers.set(transferId, bytes);
  return { transferId, contentType: response.headers.get("content-type") ?? "application/octet-stream", contentDisposition: response.headers.get("content-disposition") ?? "", size: bytes.byteLength, variant };
}

async function fetchBinaryFallback(candidates: Array<{ url: string; variant: string }>, label: string): Promise<unknown> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try { return await fetchBinary(candidate.url, label, candidate.variant); }
    catch (error) { errors.push(error instanceof Error ? error.message : "request failed"); }
  }
  throw new Error(`${label} was unavailable (${errors.join("; ")})`);
}

function transferPhase(parameters: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (parameters?.phase === "chunk") {
    const transferId = safeToken(parameters.transferId, "asset transfer ID");
    const bytes = assetTransfers.get(transferId); if (!bytes) throw new Error("provider asset transfer expired");
    const offset = safeInteger(parameters.offset, "asset offset");
    const length = Math.min(safeInteger(parameters.length, "asset chunk length"), 262_144);
    const value = bytes.subarray(offset, offset + length);
    let binary = ""; const block = 0x8000;
    for (let cursor = 0; cursor < value.length; cursor += block) binary += String.fromCharCode(...value.subarray(cursor, cursor + block));
    return { base64: btoa(binary), offset, length: value.byteLength };
  }
  if (parameters?.phase === "end") {
    assetTransfers.delete(safeToken(parameters.transferId, "asset transfer ID"));
    return { released: true };
  }
  return undefined;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`invalid ${label}`);
  return value as number;
}

function requireHost(hostname: string): void {
  if (location.hostname !== hostname) throw new Error("wrong provider tab");
}
