const SAFE_ID = /^[A-Za-z0-9._~-]+$/;

export const GROK_ORIGIN = "https://grok.com";

export function conversationListPath(pageSize: number, pageToken?: string, workspaceId?: string): string {
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) query.set("pageToken", pageToken);
  if (workspaceId) query.set("workspaceId", safeId(workspaceId));
  return `/rest/app-chat/conversations?${query.toString()}`;
}

export function conversationMetadataPath(conversationId: string): string {
  return `/rest/app-chat/conversations/${safeId(conversationId)}`;
}

export function responseNodesPath(conversationId: string): string {
  return `${conversationMetadataPath(conversationId)}/response-node?includeThreads=true`;
}

export function loadResponsesPath(conversationId: string): string {
  return `${conversationMetadataPath(conversationId)}/load-responses`;
}

export function assetPath(assetId: string): string {
  return `/rest/assets/${safeId(assetId)}`;
}

export function assetsListPath(pageSize: number, pageToken?: string): string {
  const query = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: "ORDER_BY_LAST_USE_TIME",
  });
  if (pageToken) query.set("pageToken", pageToken);
  return `/rest/assets?${query.toString()}`;
}

export function workspacesListPath(pageSize: number, pageToken?: string): string {
  const query = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: "ORDER_BY_LAST_USE_TIME",
  });
  if (pageToken) query.set("pageToken", pageToken);
  return `/rest/workspaces?${query.toString()}`;
}

export function workspaceDetailPath(workspaceId: string): string {
  return `/rest/workspaces/${safeId(workspaceId)}`;
}

export function isAllowedGrokApiRequest(path: string, method: "GET" | "POST"): boolean {
  const url = new URL(path, GROK_ORIGIN);
  if (url.origin !== GROK_ORIGIN || !path.startsWith("/")) return false;

  const pathname = url.pathname;
  if (method === "GET" && pathname === "/rest/app-chat/conversations") return true;
  if (method === "GET" && pathname === "/rest/assets") return true;
  if (method === "GET" && pathname === "/rest/workspaces") return true;
  if (method === "GET" && /^\/rest\/assets\/[A-Za-z0-9._~-]+$/.test(pathname)) return true;
  if (method === "GET" && /^\/rest\/workspaces\/[A-Za-z0-9._~-]+$/.test(pathname)) return true;
  if (method === "GET" && /^\/rest\/app-chat\/conversations\/[A-Za-z0-9._~-]+$/.test(pathname)) return true;
  if (method === "GET" && /^\/rest\/app-chat\/conversations\/[A-Za-z0-9._~-]+\/response-node$/.test(pathname)) {
    return url.searchParams.get("includeThreads") === "true";
  }
  return method === "POST" && /^\/rest\/app-chat\/conversations\/[A-Za-z0-9._~-]+\/load-responses$/.test(pathname);
}

function safeId(value: string): string {
  if (!value || !SAFE_ID.test(value)) throw new Error(`Unsafe Grok identifier: ${value}`);
  return encodeURIComponent(value);
}
