// Adapted from GrokExporter commit 85922d6; this baseline proves tab discovery and deny-by-default transport.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

await import("./build.mjs");
const root = process.cwd();
const extensionPath = path.join(root, "dist", "extension");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-exporter-e2e-"));
const certificatePath = path.join(temporaryRoot, "certificate.pem");
const keyPath = path.join(temporaryRoot, "key.pem");
let conversationListingRequests = 0;
let batchRequests = 0;
let holdNextInventoryResponse = false;
let releaseHeldInventoryResponse;
let holdNextBatchResponse = false;
let releaseHeldBatchResponse;
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath,
  "-out", certificatePath,
  "-subj", "/CN=chatgpt.com",
  "-addext", "subjectAltName=DNS:chatgpt.com",
  "-days", "1",
], { stdio: "ignore" });

const server = https.createServer({
  key: await readFile(keyPath),
  cert: await readFile(certificatePath),
}, (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "https://chatgpt.com");
  if (requestUrl.pathname === "/api/auth/session") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ accessToken: "synthetic-page-local-secret", expires: "2099-01-01T00:00:00.000Z" }));
    return;
  }
  if (requestUrl.pathname === "/backend-api/conversations") {
    conversationListingRequests += 1;
    if (requestUrl.searchParams.get("offset") === "42") {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "2" });
      response.end(JSON.stringify({ private_fixture_body: "must-not-cross-error-boundary" }));
      return;
    }
    if (requestUrl.searchParams.get("offset") === "43") {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ private_fixture_body: "forbidden-body-must-not-cross" }));
      return;
    }
    if (requestUrl.searchParams.get("offset") === "44") {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ private_fixture_body: "server-body-must-not-cross" }));
      return;
    }
    if (requestUrl.searchParams.get("offset") === "45") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{invalid-json");
      return;
    }
    if (requestUrl.searchParams.get("offset") === "46") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify("x".repeat(20_000_001)));
      return;
    }
    if (requestUrl.searchParams.get("offset") === "47") {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ items: [], total: 0, offset: 47, limit: 1 }));
      }, 2_000);
      return;
    }
    const authorized = request.headers.authorization === "Bearer synthetic-page-local-secret"
      && request.headers["x-authorization"] === "Bearer synthetic-page-local-secret";
    const gate = holdNextInventoryResponse
      ? new Promise((resolve) => {
        holdNextInventoryResponse = false;
        releaseHeldInventoryResponse = resolve;
      })
      : Promise.resolve();
    void gate.then(() => setTimeout(() => {
      response.writeHead(authorized ? 200 : 401, { "Content-Type": "application/json" });
      response.end(JSON.stringify(authorized ? {
        items: [
          { id: "conversation-1", title: "Synthetic one", create_time: 1, update_time: 2 },
          { id: "conversation-2", title: "Synthetic two", create_time: 3, update_time: 4 },
        ],
        total: 2,
        offset: Number(requestUrl.searchParams.get("offset") ?? 0),
        limit: Number(requestUrl.searchParams.get("limit") ?? 100),
      } : { error: "fixture rejected request" }));
    }, 75));
    return;
  }
  if (requestUrl.pathname === "/backend-api/conversations/batch") {
    batchRequests += 1;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const ids = JSON.parse(body).conversation_ids;
      const gate = holdNextBatchResponse
        ? new Promise((resolve) => {
          holdNextBatchResponse = false;
          releaseHeldBatchResponse = resolve;
        })
        : Promise.resolve();
      void gate.then(() => setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(ids.map(syntheticConversation)));
      }, 75));
    });
    return;
  }
  if (requestUrl.pathname === "/backend-api/accounts/check/v4-2023-04-27") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      accounts: {
        synthetic: {
          account: { account_id: "account-1", account_name: "Synthetic workspace", account_plan: "business" },
          structure: "workspace",
          is_deactivated: false,
        },
      },
    }));
    return;
  }
  if (requestUrl.pathname === "/backend-api/files/download/file-1") {
    const signedQuery = `${["s", "ig"].join("")}=synthetic-signed-value`;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      download_url: `https://chatgpt.com:${server.address().port}/asset-bytes?${signedQuery}`,
      mime_type: "text/plain",
      size: 21,
    }));
    return;
  }
  if (requestUrl.pathname === "/asset-bytes") {
    const bytes = Buffer.from("synthetic asset bytes");
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const end = match ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    response.writeHead(match ? 206 : 200, {
      "Content-Type": "text/plain",
      "Content-Length": String(end - start + 1),
      ...(match ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
    });
    response.end(bytes.subarray(start, end + 1));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>Synthetic ChatGPT</title><main>Fixture</main>");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Synthetic ChatGPT server did not expose a TCP port.");

let context;
try {
  const chromeExecutable = await findChromeExecutable();
  if (!chromeExecutable) {
    throw new Error("Chromium executable not found; run `npx playwright install chromium` or set CHATGPT_EXPORTER_CHROME.");
  }
  context = await chromium.launchPersistentContext(path.join(temporaryRoot, "profile"), {
    executablePath: chromeExecutable,
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--host-resolver-rules=MAP chatgpt.com 127.0.0.1",
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
  });
  const chatgptPage = await context.newPage();
  await chatgptPage.goto(`https://chatgpt.com:${address.port}/`, { waitUntil: "domcontentloaded" });

  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);

  const tab = await dashboard.evaluate(async () => chrome.runtime.sendMessage({ type: "CHATGPT_EXPORTER_FIND_TAB" }));
  assert(tab.ok && Number.isInteger(tab.tabId), "Service worker did not discover the synthetic ChatGPT tab.");

  const sessionProbe = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "CHATGPT_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "session-probe",
      protocolVersion: 1,
      workspaceId: null,
      operation: "session_probe",
      parameters: {},
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(sessionProbe.ok && sessionProbe.body?.authenticated, `Page-local session probe failed: ${JSON.stringify(sessionProbe)}`);
  assert(!JSON.stringify(sessionProbe).includes("synthetic-page-local-secret"), "Session token crossed the page-world bridge.");

  const listing = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "CHATGPT_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "conversation-page",
      protocolVersion: 1,
      workspaceId: null,
      operation: "conversation_page",
      parameters: { offset: 0, limit: 1, archived: false },
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(listing.ok && listing.body?.items?.[0]?.id === "conversation-1", `Authenticated listing failed: ${JSON.stringify(listing)}`);
  assert(!JSON.stringify(listing).includes("synthetic-page-local-secret"), "Authorization token crossed the page-world bridge.");

  const rejected = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "CHATGPT_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "rejected-request",
      protocolVersion: 1,
      workspaceId: null,
      operation: "conversation_detail",
      parameters: { conversationId: "../../private", url: "https://evil.example/private" },
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(!rejected.ok && rejected.error?.code === "INVALID_BRIDGE_REQUEST", "Typed transport did not fail closed.");

  const rateLimited = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "CHATGPT_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "rate-limited-request",
      protocolVersion: 1,
      workspaceId: null,
      operation: "conversation_page",
      parameters: { offset: 42, limit: 1, archived: false },
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(!rateLimited.ok && rateLimited.error?.code === "RATE_LIMITED" && rateLimited.error?.retryAfterMs === 2_000, "Rate-limit metadata was not preserved.");
  assert(!JSON.stringify(rateLimited).includes("must-not-cross-error-boundary"), "HTTP error response body crossed the redacted bridge boundary.");

  for (const failure of [
    { offset: 43, code: "WORKSPACE_FORBIDDEN", retryable: false, secret: "forbidden-body-must-not-cross" },
    { offset: 44, code: "CHATGPT_HTTP_ERROR", retryable: true, secret: "server-body-must-not-cross" },
    { offset: 45, code: "INVALID_JSON_RESPONSE", retryable: false },
    { offset: 46, code: "RESPONSE_TOO_LARGE", retryable: false },
    { offset: 47, code: "REQUEST_TIMEOUT", retryable: true, timeoutMs: 1_000 },
  ]) {
    const result = await dashboard.evaluate(async ({ tabId, failure }) => chrome.runtime.sendMessage({
      type: "CHATGPT_EXPORTER_API_REQUEST",
      tabId,
      request: {
        requestId: `failure-${failure.offset}`,
        protocolVersion: 1,
        workspaceId: null,
        operation: "conversation_page",
        parameters: { offset: failure.offset, limit: 1, archived: false },
        timeoutMs: failure.timeoutMs ?? 10_000,
      },
    }), { tabId: tab.tabId, failure });
    assert(!result.ok && result.error?.code === failure.code && result.error?.retryable === failure.retryable, `Failure contract ${failure.code} was not preserved.`);
    assert(!failure.secret || !JSON.stringify(result).includes(failure.secret), `Private ${failure.code} response crossed the bridge.`);
  }

  const assetOpen = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "CHATGPT_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "asset-open",
      protocolVersion: 1,
      workspaceId: null,
      operation: "asset_open",
      parameters: { fileId: "file-1", conversationId: "conversation-1", projectId: null },
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(assetOpen.ok && typeof assetOpen.body?.handleId === "string", `Asset handle open failed: ${JSON.stringify(assetOpen)}`);
  assert(!JSON.stringify(assetOpen).includes("synthetic-signed-value"), "Signed asset URL crossed the page-world bridge.");
  const assetChunk = await dashboard.evaluate(async ({ tabId, handleId }) => chrome.runtime.sendMessage({
    type: "CHATGPT_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "asset-chunk",
      protocolVersion: 1,
      workspaceId: null,
      operation: "asset_chunk",
      parameters: { handleId, offset: 0, length: 1024 },
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId, handleId: assetOpen.body.handleId });
  assert(assetChunk.ok && assetChunk.body?.eof && atob(assetChunk.body.dataBase64) === "synthetic asset bytes", "Chunked asset bytes were not returned correctly.");
  const assetClose = await dashboard.evaluate(async ({ tabId, handleId }) => chrome.runtime.sendMessage({
    type: "CHATGPT_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "asset-close",
      protocolVersion: 1,
      workspaceId: null,
      operation: "asset_close",
      parameters: { handleId },
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId, handleId: assetOpen.body.handleId });
  assert(assetClose.ok && assetClose.body?.closed, "Asset handle did not close.");

  await dashboard.locator("#find-chatgpt").click();
  await dashboard.locator("#workspace-select:not([disabled])").waitFor();
  assert(await dashboard.locator("#workspace-select option").count() === 2, "Dashboard did not render explicit workspace selection.");
  await dashboard.locator("#workspace-select").selectOption({ index: 1 });
  await dashboard.locator("#preflight-workspace").click();
  await dashboard.locator("#choose-directory:not([disabled])").waitFor();
  assert((await dashboard.locator("#status").textContent())?.includes("Verified 1 selected workspace"), "Dashboard preflight did not reach the verified state.");

  await dashboard.evaluate(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => navigator.storage.getDirectory(),
    });
  });
  await dashboard.locator("#choose-directory").click();
  await dashboard.locator("#run-inventory:not([disabled])").waitFor();
  await dashboard.locator("#scope-projects").uncheck();
  await dashboard.locator("#scope-shared").uncheck();
  await dashboard.locator("#request-delay").fill("100");
  const listingRequestsBeforeInventory = conversationListingRequests;
  holdNextInventoryResponse = true;
  await dashboard.locator("#run-inventory").click();
  await waitFor(() => conversationListingRequests === listingRequestsBeforeInventory + 1, "Inventory request did not start.");
  await dashboard.locator("#pause-run:not([disabled])").click();
  await dashboard.locator('#status[data-state="paused"]').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert(conversationListingRequests === listingRequestsBeforeInventory + 1, "Pause allowed the next inventory request to start.");
  releaseHeldInventoryResponse?.();
  await dashboard.locator("#resume-run:not([disabled])").click();
  await dashboard.locator("#confirm-inventory:not([disabled])").waitFor();
  assert((await dashboard.locator("#inventory-summary").textContent())?.includes("2 conversations"), "Dashboard inventory summary did not reconcile two conversations.");
  await dashboard.locator("#confirm-inventory").click();

  await dashboard.locator("#scope-account").uncheck();
  await dashboard.locator("#scope-assets").uncheck();
  await dashboard.locator("#batch-size").fill("1");
  holdNextBatchResponse = true;
  await dashboard.locator("#run-capture").click();
  await waitFor(() => batchRequests === 1, "Capture request did not start.");
  await dashboard.locator("#pause-run:not([disabled])").click();
  await dashboard.locator('#status[data-state="paused"]').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert(batchRequests === 1, "Pause allowed the next capture batch to start.");
  releaseHeldBatchResponse?.();
  await dashboard.locator("#resume-run:not([disabled])").click();
  await dashboard.locator('#status[data-state="complete"]').waitFor({ timeout: 15_000 });
  assert((await dashboard.locator("#status").textContent())?.includes("Capture complete"), "Dashboard capture did not reach an audited complete state.");
  const firstTreeHash = await dashboard.evaluate(hashAuthoritativeArchiveTree);
  assert(firstTreeHash.pathCount >= 18 && typeof firstTreeHash.hash === "string", "Packaged dashboard did not publish the expected archive tree.");
  await dashboard.locator("#revalidate").click();
  await dashboard.locator('#status[data-state="complete"]').waitFor();
  const secondTreeHash = await dashboard.evaluate(hashAuthoritativeArchiveTree);
  assert(secondTreeHash.hash === firstTreeHash.hash, "Revalidate-only changed authoritative conversation/archive bytes.");
  console.log(`Chromium packaged dashboard, pause/resume, directory, and archive-tree test passed (${firstTreeHash.hash.slice(0, 12)}).`);
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function syntheticConversation(id) {
  return {
    id,
    title: `Synthetic ${id}`,
    create_time: id.endsWith("1") ? 1 : 3,
    update_time: id.endsWith("1") ? 2 : 4,
    current_node: `assistant-${id}`,
    mapping: {
      [`root-${id}`]: { id: `root-${id}`, message: null, parent: null, children: [`user-${id}`] },
      [`user-${id}`]: {
        id: `user-${id}`,
        parent: `root-${id}`,
        children: [`assistant-${id}`],
        message: {
          id: `message-user-${id}`,
          author: { role: "user" },
          create_time: 1,
          content: { content_type: "text", parts: ["Synthetic prompt."] },
          status: "finished_successfully",
          end_turn: null,
          recipient: "all",
          metadata: {},
        },
      },
      [`assistant-${id}`]: {
        id: `assistant-${id}`,
        parent: `user-${id}`,
        children: [],
        message: {
          id: `message-assistant-${id}`,
          author: { role: "assistant" },
          create_time: 2,
          content: { content_type: "text", parts: ["Synthetic response."] },
          status: "finished_successfully",
          end_turn: true,
          recipient: "all",
          metadata: { model_slug: "synthetic-model" },
        },
      },
    },
  };
}

async function hashAuthoritativeArchiveTree() {
  const root = await navigator.storage.getDirectory();
  const rows = [];
  async function walk(directory, base) {
    for await (const [name, handle] of directory.entries()) {
      const relative = base ? `${base}/${name}` : name;
      if (handle.kind === "directory") {
        await walk(handle, relative);
        continue;
      }
      if (!relative.includes("/conversations/")
        && !relative.includes("/source/inventory/")
        && !relative.includes("/assets/")) continue;
      const bytes = await (await handle.getFile()).arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      rows.push(`${relative}\0${hash}`);
    }
  }
  await walk(root, "");
  rows.sort();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rows.join("\n")));
  return {
    pathCount: rows.length,
    hash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

async function findChromeExecutable() {
  const candidates = [process.env.CHATGPT_EXPORTER_CHROME, chromium.executablePath()];
  const cacheRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const installs = (await readdir(cacheRoot))
      .filter((entry) => entry.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const install of installs) {
      candidates.push(path.join(cacheRoot, install, "chrome-linux64", "chrome"));
    }
  } catch {
    // A fresh checkout may not have a Playwright cache yet.
  }
  candidates.push("/usr/bin/chromium", "/usr/bin/google-chrome");
  return candidates.find((candidate) => candidate && existsSync(candidate));
}
