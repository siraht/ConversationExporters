import { resolve } from "node:path";
import { chromium } from "playwright";
import type { SyncConfig } from "./types.js";

export async function runExporterExtensions(config: SyncConfig, intervalSeconds: number): Promise<void> {
  const repository = resolve(import.meta.dirname, "..", "..", "..");
  const chatgpt = resolve(repository, "packages", "chatgpt-exporter", "dist", "extension");
  const grok = resolve(repository, "packages", "grok-exporter", "dist", "extension");
  const profile = resolve(config.dataRoot, "browser-profiles", "extensions");
  const extensions = `${chatgpt},${grok}`;
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${extensions}`, `--load-extension=${extensions}`],
  });
  try {
    await Promise.all([
      openIfMissing(context, "https://chatgpt.com/"),
      openIfMissing(context, "https://grok.com/"),
    ]);
    const workers = await waitForWorkers(context, 2);
    for (const worker of workers) {
      const id = new URL(worker.url()).host;
      const manifest = await worker.evaluate(() => {
        const extension = globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } };
        return extension.chrome.runtime.getManifest().name;
      });
      await openIfMissing(context, `chrome-extension://${id}/dashboard.html?auto=${intervalSeconds}`);
      process.stdout.write(`${manifest}: automatic dashboard opened\n`);
    }
    await new Promise<void>((resolveClose) => context.on("close", () => resolveClose()));
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function waitForWorkers(context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>, count: number) {
  const deadline = Date.now() + 30_000;
  while (context.serviceWorkers().length < count && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const workers = context.serviceWorkers();
  if (workers.length < count) throw new Error(`only ${workers.length} of ${count} exporter extensions started`);
  return workers;
}

async function openIfMissing(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  url: string,
): Promise<void> {
  if (context.pages().some((page) => page.url() === url)) return;
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
}
