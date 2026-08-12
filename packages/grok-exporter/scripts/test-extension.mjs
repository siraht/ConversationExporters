import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

await import("./build.mjs");
const root = process.cwd();
const extensionPath = path.join(root, "dist", "extension");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "grok-exporter-e2e-"));
const certificatePath = path.join(temporaryRoot, "certificate.pem");
const keyPath = path.join(temporaryRoot, "key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath,
  "-out", certificatePath,
  "-subj", "/CN=grok.com",
  "-addext", "subjectAltName=DNS:grok.com",
  "-days", "1",
], { stdio: "ignore" });

const server = https.createServer({
  key: await readFile(keyPath),
  cert: await readFile(certificatePath),
}, (request, response) => {
  const url = new URL(request.url ?? "/", "https://grok.com");
  if (url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Set-Cookie": "sso=fixture; Secure; SameSite=Lax; Path=/",
    });
    response.end("<!doctype html><title>Synthetic Grok</title><main>Fixture</main>");
    return;
  }
  if (url.pathname === "/rest/app-chat/conversations" && request.headers.cookie?.includes("sso=fixture")) {
    if (url.searchParams.has("html")) {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Sign in</title>");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ conversations: [{ conversationId: "fixture-conversation", title: "Synthetic" }] }));
    return;
  }
  response.writeHead(403, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "fixture rejected request" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Synthetic Grok server did not expose a TCP port.");

let context;
try {
  context = await chromium.launchPersistentContext(path.join(temporaryRoot, "profile"), {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--host-resolver-rules=MAP grok.com 127.0.0.1",
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
  });
  const grokPage = await context.newPage();
  await grokPage.goto(`https://grok.com:${address.port}/`, { waitUntil: "domcontentloaded" });

  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);

  const tab = await dashboard.evaluate(async () => chrome.runtime.sendMessage({ type: "GROK_EXPORTER_FIND_TAB" }));
  assert(tab.ok && Number.isInteger(tab.tabId), "Service worker did not discover the synthetic Grok tab.");
  const response = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "GROK_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "fixture-request",
      protocolVersion: 1,
      path: "/rest/app-chat/conversations?pageSize=100",
      method: "GET",
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(response.ok, `Authenticated bridge failed: ${JSON.stringify(response)}`);
  assert(response.body?.conversations?.[0]?.conversationId === "fixture-conversation", "Bridge returned the wrong fixture body.");

  const html = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "GROK_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "html-request",
      protocolVersion: 1,
      path: "/rest/app-chat/conversations?pageSize=100&html=1",
      method: "GET",
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(!html.ok && html.error?.code === "GROK_NON_JSON_RESPONSE", "Bridge did not classify an HTML login response safely.");

  const rejected = await dashboard.evaluate(async ({ tabId }) => chrome.runtime.sendMessage({
    type: "GROK_EXPORTER_API_REQUEST",
    tabId,
    request: {
      requestId: "rejected-request",
      protocolVersion: 1,
      path: "https://evil.example/private",
      method: "GET",
      timeoutMs: 10_000,
    },
  }), { tabId: tab.tabId });
  assert(!rejected.ok && rejected.error?.code === "INVALID_BRIDGE_REQUEST", "Service worker did not reject an arbitrary origin.");
  console.log("Chromium extension bridge test passed.");
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
