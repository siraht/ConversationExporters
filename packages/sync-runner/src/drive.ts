import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SyncConfig } from "./types.js";

export interface DriveCaptureSummary {
  provider: "google-ai-studio";
  copied: boolean;
}

export async function captureAiStudio(config: SyncConfig): Promise<DriveCaptureSummary> {
  const destination = join(config.dataRoot, "live", "google-ai-studio");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await run(config.rcloneBinary, [
    "copy",
    `${config.driveRemote}:${config.drivePath}`,
    destination,
    "--create-empty-src-dirs",
    "--metadata",
    "--log-level", "ERROR",
  ]);
  return { provider: "google-ai-studio", copied: true };
}

export async function configureDrive(config: SyncConfig): Promise<void> {
  await inherited(config.rcloneBinary, ["config"]);
}

async function run(command: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`AI Studio Drive copy failed${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`));
    });
  });
}

async function inherited(command: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error("Drive configuration did not complete")));
  });
}
