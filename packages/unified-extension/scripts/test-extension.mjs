import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const extensionPath = path.join(root, "dist", "chrome");
const profile = await mkdtemp(path.join(tmpdir(), "conversation-archive-extension-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const dashboard = await context.newPage();
  const errors = [];
  dashboard.on("pageerror", (error) => errors.push(error.message));
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await dashboard.waitForSelector("#archive-status");
  const release = path.join(root, "dist", "releases");
  await mkdir(release, { recursive: true });
  await dashboard.setViewportSize({ width: 1280, height: 800 });
  await dashboard.screenshot({ path: path.join(release, "store-screenshot-1280x800.png") });
  await dashboard.setViewportSize({ width: 440, height: 280 });
  await dashboard.screenshot({ path: path.join(release, "store-promo-440x280.png") });
  await dashboard.setViewportSize({ width: 1280, height: 800 });
  const manifest = await dashboard.evaluate(() => chrome.runtime.getManifest());
  assert(manifest.name === "Conversation Archive", "Packaged manifest did not load");
  assert(await dashboard.locator("[data-provider]").count() === 3, "Unified provider controls did not render");
  const settings = await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: "UNIFIED_GET_SETTINGS" }));
  assert(settings.ok && settings.settings.vpsEnabled === false, "Service worker settings protocol failed");
  await dashboard.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("conversation-exporters-archives", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("files", "readwrite");
      transaction.objectStore("files").put({ key: "claude-web/smoke.json", bytes: new Blob(["{}"], { type: "application/json" }) });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  const archive = await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: "UNIFIED_ARCHIVE_STATUS" }));
  assert(archive.ok && archive.result.some((item) => item.namespace === "claude-web" && item.files === 1), "IndexedDB archive was not visible to the service worker");
  await dashboard.selectOption("#export-provider", "claude-web");
  const [download] = await Promise.all([dashboard.waitForEvent("download"), dashboard.click("#export-archive")]);
  const downloadPath = await download.path();
  assert(downloadPath && (await stat(downloadPath)).size > 0, "Browser ZIP export was empty");
  for (const pageName of ["chatgpt.html", "grok.html", "chatgpt-folder.html", "grok-folder.html"]) {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${pageName}: ${error.message}`));
    await page.goto(`chrome-extension://${extensionId}/${pageName}`);
    await page.waitForSelector("main");
    await page.close();
  }
  assert(errors.length === 0, `Extension pages raised errors: ${errors.join("; ")}`);
  process.stdout.write("Unified Chromium extension smoke test passed.\n");
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}

function assert(condition, message) { if (!condition) throw new Error(message); }
