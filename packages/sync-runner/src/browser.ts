import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { SyncConfig } from "./types.js";

export type BrowserProvider = "claude" | "gemini";

export async function launchProviderBrowser(
  config: SyncConfig,
  provider: BrowserProvider,
  headed: boolean,
): Promise<BrowserContext> {
  const profile = join(config.dataRoot, "browser-profiles", provider);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const installedChrome = process.env.CONVERSATION_BROWSER_EXECUTABLE
    || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  return await chromium.launchPersistentContext(profile, {
    headless: !headed,
    ...(installedChrome ? { executablePath: installedChrome } : {}),
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

export function providerUrl(provider: BrowserProvider): string {
  return provider === "claude" ? "https://claude.ai/" : "https://gemini.google.com/app";
}

export async function login(config: SyncConfig, provider: BrowserProvider): Promise<void> {
  const context = await launchProviderBrowser(config, provider, true);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(providerUrl(provider), { waitUntil: "domcontentloaded", timeout: 60_000 });
  process.stdout.write(`Sign in to ${provider} in the opened browser, then press Enter here.\n`);
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  await context.close();
}
