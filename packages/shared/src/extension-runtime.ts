export interface FindProviderTabResult {
  ok: boolean;
  tabId?: number;
  title?: string;
  error?: string;
}

export function installDashboardAction(query = ""): void {
  chrome.action.onClicked.addListener(() => {
    void chrome.tabs.create({ url: `${chrome.runtime.getURL("dashboard.html")}${query}` });
  });
}

export function isTrustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
}

export async function findProviderTab(urls: string[], missingMessage: string): Promise<FindProviderTabResult> {
  const tabs = await chrome.tabs.query({ url: urls });
  const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
  if (tab?.id === undefined) return { ok: false, error: missingMessage };
  return { ok: true, tabId: tab.id, ...(tab.title === undefined ? {} : { title: tab.title }) };
}

export async function sendPageRequest<Response>(tabId: number, type: string, request: unknown): Promise<Response> {
  return await chrome.tabs.sendMessage(tabId, { type, request }) as Response;
}
