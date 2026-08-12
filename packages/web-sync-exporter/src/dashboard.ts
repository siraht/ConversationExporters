import type { Provider, SyncSummary } from "./protocol";

const status = required("status");
const log = required("log");
required("sync-claude").addEventListener("click", () => void run("claude"));
required("sync-gemini").addEventListener("click", () => void run("gemini"));
required("sync-all").addEventListener("click", () => void runBoth());

async function runBoth(): Promise<void> {
  await run("claude");
  await run("gemini");
}

async function run(provider: Provider): Promise<void> {
  status.textContent = `Syncing ${provider}…`;
  const response = await chrome.runtime.sendMessage<{ type: "WEB_SYNC_RUN"; provider: Provider }, { ok: boolean; result?: SyncSummary; error?: string }>({ type: "WEB_SYNC_RUN", provider });
  if (!response.ok || !response.result) { status.textContent = response.error ?? `${provider} sync failed`; return; }
  const result = response.result;
  status.textContent = `${provider}: ${result.discovered} discovered, ${result.fetched} fetched, ${result.unchanged} unchanged.`;
  log.textContent = `${new Date().toLocaleString()} ${status.textContent}\n${log.textContent}`.slice(0, 8_000);
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing dashboard element: ${id}`);
  return element;
}
