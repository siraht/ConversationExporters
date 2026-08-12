import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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

export async function replicateWebSources(
  config: SyncConfig,
  sources: Array<Pick<ImportResult, "source" | "provider">>,
): Promise<{ mirroredSources: number; remoteNewVersions: number }> {
  const liveRoot = resolve(config.dataRoot, "live");
  const eligible: Array<{ source: string; provider: Provider; relativePath: string }> = [];
  for (const item of sources) {
    const source = resolve(item.source);
    const relativePath = relative(config.dataRoot, source).replaceAll("\\", "/");
    if (item.provider && source.startsWith(`${liveRoot}/`)) eligible.push({ source, provider: item.provider, relativePath });
  }
  if (!eligible.length) return { mirroredSources: 0, remoteNewVersions: 0 };
  safeRemote(config.destination, "destination");
  safeRemote(config.remoteMirrorRoot, "remote mirror root", true);
  safeRemote(config.remoteArchiveRoot, "remote archive root", true);
  safeRemote(config.remoteAsmBinary, "remote ASM command", true);
  safeRemote(config.accountLabel, "account label");

  let mirroredSources = 0;
  let remoteNewVersions = 0;
  for (const item of eligible) {
    safeRemote(item.relativePath, "relative source path", true);
    const remoteSource = join(config.remoteMirrorRoot, item.relativePath).replaceAll("\\", "/");
    const privateDirectories = [...new Set([dirname(config.remoteMirrorRoot), config.remoteMirrorRoot, dirname(remoteSource)])];
    const mkdirResult = await run(config.sshBinary, ["--", config.destination, "mkdir", "-p", "--", ...privateDirectories]);
    if (mkdirResult.exitCode !== 0) throw new Error("web mirror directory creation failed");
    const chmodResult = await run(config.sshBinary, ["--", config.destination, "chmod", "700", "--", ...privateDirectories]);
    if (chmodResult.exitCode !== 0) throw new Error("web mirror privacy setup failed");
    const metadata = await stat(item.source);
    const localArgument = metadata.isDirectory() ? `${item.source}/` : item.source;
    const remoteArgument = `${config.destination}:${metadata.isDirectory() ? `${remoteSource}/` : remoteSource}`;
    const copy = await run(config.rsyncBinary, [
      "--archive", "--protect-args", "--partial", "--compress", "--compress-choice=zstd",
      "--itemize-changes", "--out-format=%i",
      "--chmod=F600,D700", "--", localArgument, remoteArgument,
    ]);
    if (copy.exitCode !== 0) throw new Error("web mirror transfer failed");
    if (!copy.stdout.trim()) continue;
    const imported = await run(config.sshBinary, [
      "--", config.destination, config.remoteAsmBinary, "--root", config.remoteArchiveRoot,
      "web-import", remoteSource, "--account-label", config.accountLabel, "--provider", item.provider, "--json",
    ]);
    const envelope = parseEnvelope(imported.stdout || imported.stderr);
    if (imported.exitCode !== 0 || envelope.ok !== true || !envelope.result) {
      const code = typeof envelope.error?.code === "string" ? envelope.error.code : "remote_web_import_failed";
      throw new Error(`remote web import failed (${code})`);
    }
    mirroredSources += 1;
    remoteNewVersions += numberValue(envelope.result.new_versions);
  }
  return { mirroredSources, remoteNewVersions };
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

function safeRemote(value: string, name: string, allowSlash = false): void {
  const pattern = allowSlash ? /^[A-Za-z0-9._/-]+$/ : /^[A-Za-z0-9._-]+$/;
  if (!pattern.test(value) || value.split("/").includes("..")) throw new Error(`${name} is unsafe`);
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
