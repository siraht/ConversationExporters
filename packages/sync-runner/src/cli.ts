#!/usr/bin/env node
import { configFromEnvironment } from "./config.js";
import { syncOnce } from "./sync.js";

async function main(arguments_: string[]): Promise<void> {
  const command = arguments_[0] ?? "once";
  const push = arguments_.includes("--push");
  const config = configFromEnvironment();

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
    while (true) {
      try {
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
  return new Error(`${prefix}Usage:\n  conversation-sync once [--push]\n  conversation-sync import PATH [--push]\n  conversation-sync watch [--interval SECONDS] [--push]\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${safeMessage(error)}\n`);
  process.exitCode = 1;
});
