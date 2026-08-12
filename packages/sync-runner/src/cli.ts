#!/usr/bin/env node
import { configFromEnvironment } from "./config.js";
import { syncOnce } from "./sync.js";
import { captureClaude } from "./claude.js";
import { captureGemini } from "./gemini.js";
import { login, type BrowserProvider } from "./browser.js";
import { captureAiStudio, configureDrive } from "./drive.js";

type CaptureProvider = BrowserProvider | "ai-studio";

async function main(arguments_: string[]): Promise<void> {
  const command = arguments_[0] ?? "once";
  const push = arguments_.includes("--push");
  const config = configFromEnvironment();

  if (command === "login") {
    const provider = captureProvider(arguments_[1]);
    if (provider === "ai-studio") await configureDrive(config);
    else await login(config, provider);
    return;
  }

  if (command === "capture") {
    const provider = captureProvider(arguments_[1]);
    const headed = arguments_.includes("--headed");
    print(provider === "claude"
      ? await captureClaude(config, headed)
      : provider === "gemini"
        ? await captureGemini(config, headed)
        : await captureAiStudio(config));
    print(await syncOnce(config, { push }));
    return;
  }

  if (command === "once") {
    print(await syncOnce(config, { push }));
    return;
  }

  if (command === "import") {
    const source = arguments_[1];
    if (!source || source.startsWith("--")) throw usage("import requires a source path");
    print(await syncOnce(config, { push, sources: [source] }));
    return;
  }

  if (command === "watch") {
    const intervalSeconds = positiveNumber(option(arguments_, "--interval") ?? "3600", "interval");
    const capture = captureList(option(arguments_, "--capture"));
    while (true) {
      try {
        for (const provider of capture) {
          try {
            print(provider === "claude"
              ? await captureClaude(config)
              : provider === "gemini"
                ? await captureGemini(config)
                : await captureAiStudio(config));
          } catch (error) {
            process.stderr.write(`${provider}: ${safeMessage(error)}\n`);
          }
        }
        print(await syncOnce(config, { push }));
      } catch (error) {
        process.stderr.write(`${safeMessage(error)}\n`);
      }
      await delay(intervalSeconds * 1000);
    }
  }

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage().message);
    return;
  }
  throw usage(`unknown command: ${command}`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function option(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw usage(`${name} must be positive`);
  return parsed;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "conversation sync failed";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usage(reason?: string): Error {
  const prefix = reason ? `${reason}\n\n` : "";
  return new Error(`${prefix}Usage:\n  conversation-sync login <claude|gemini|ai-studio>\n  conversation-sync capture <claude|gemini|ai-studio> [--headed] [--push]\n  conversation-sync once [--push]\n  conversation-sync import PATH [--push]\n  conversation-sync watch [--capture claude,gemini,ai-studio] [--interval SECONDS] [--push]\n`);
}

function captureProvider(value: string | undefined): CaptureProvider {
  if (value === "claude" || value === "gemini" || value === "ai-studio") return value;
  throw usage("provider must be claude, gemini, or ai-studio");
}

function captureList(value: string | undefined): CaptureProvider[] {
  if (!value) return [];
  return value.split(",").filter(Boolean).map(captureProvider);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${safeMessage(error)}\n`);
  process.exitCode = 1;
});
