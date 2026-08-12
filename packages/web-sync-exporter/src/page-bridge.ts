import { safeToken, type PageReply, type PageRequest } from "./protocol";
import { parseGeminiResponse } from "./gemini";

const requestChannel = "conversation-sync:page-request:v1";
const responseChannel = "conversation-sync:page-response:v1";

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { channel?: string; request?: PageRequest } | undefined;
  if (event.source !== window || event.origin !== location.origin || data?.channel !== requestChannel || !data.request) return;
  void execute(data.request).then((reply) => window.postMessage({ channel: responseChannel, reply }, location.origin));
});

async function execute(request: PageRequest): Promise<PageReply> {
  try {
    const result = request.operation === "claudeList" ? await claudeList()
      : request.operation === "claudeDetail" ? await claudeDetail(request.parameters)
        : request.operation === "geminiList" ? await geminiList()
          : request.operation === "geminiExtract" ? geminiExtract()
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
  const wiz = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data ?? {};
  const session = { sid: String(wiz.FdrFJe ?? ""), bl: String(wiz.cfb2h ?? ""), at: String(wiz.SNlM0e ?? "") };
  if (!session.sid || !session.bl || !session.at) throw new Error("Gemini authentication parameters are unavailable");
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

function geminiExtract(): { messages: Array<{ id: string; role: "user" | "assistant"; content: string }> } {
  const conversationId = location.pathname.split("/").filter(Boolean).at(-1) ?? "conversation";
  const pairs = [
    ...Array.from(document.querySelectorAll("user-query, [data-role='user'], .user-query-container")).map((element) => ({ element, role: "user" as const })),
    ...Array.from(document.querySelectorAll("model-response, [data-role='model'], .model-response-text")).map((element) => ({ element, role: "assistant" as const })),
  ].sort((left, right) => left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  return { messages: pairs.flatMap(({ element, role }, index) => element.textContent?.trim() ? [{ id: `${conversationId}-${index}`, role, content: element.textContent.trim() }] : []) };
}
