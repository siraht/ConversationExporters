import { spawn } from "node:child_process";
import type { ImportResult, Provider, SyncConfig } from "./types.js";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AsmEnvelope {
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
}

export async function importWithAsm(
  config: SyncConfig,
  source: string,
  provider?: Provider,
): Promise<ImportResult> {
  const arguments_ = [
    "--root", config.archiveRoot,
    "web-import", source,
    "--account-label", config.accountLabel,
    "--json",
  ];
  if (provider) arguments_.push("--provider", provider);
  const command = await run(config.asmBinary, arguments_);
  const envelope = parseEnvelope(command.stdout || command.stderr);
  if (command.exitCode !== 0 || envelope.ok !== true || !envelope.result) {
    if (envelope.error?.code === "adapter_not_detected") {
      return { source, status: "unsupported", candidates: 0, newVersions: 0 };
    }
    const code = typeof envelope.error?.code === "string" ? envelope.error.code : "asm_failed";
    throw new Error(`archive import failed (${code})`);
  }
  const detected = providerValue(envelope.result.provider);
  return {
    source,
    status: numberValue(envelope.result.new_versions) > 0 ? "imported" : "unchanged",
    ...(detected ? { provider: detected } : {}),
    candidates: numberValue(envelope.result.candidates),
    newVersions: numberValue(envelope.result.new_versions),
  };
}

export async function pushWithAsm(config: SyncConfig): Promise<{ objects: number; bytes: number }> {
  const command = await run(config.asmBinary, [
    "--root", config.archiveRoot,
    "push", config.destination,
    "--json",
  ]);
  const envelope = parseEnvelope(command.stdout || command.stderr);
  if (command.exitCode !== 0 || envelope.ok !== true || !envelope.result) {
    const code = typeof envelope.error?.code === "string" ? envelope.error.code : "asm_push_failed";
    throw new Error(`archive push failed (${code})`);
  }
  return {
    objects: numberValue(envelope.result.objects),
    bytes: numberValue(envelope.result.bytes),
  };
}

async function run(command: string, arguments_: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function parseEnvelope(value: string): AsmEnvelope {
  try {
    return JSON.parse(value) as AsmEnvelope;
  } catch {
    throw new Error("archive command returned invalid JSON");
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function providerValue(value: unknown): Provider | undefined {
  return value === "chatgpt-web" || value === "claude-web" || value === "gemini-web"
    || value === "google-ai-studio" || value === "grok-web" ? value : undefined;
}
