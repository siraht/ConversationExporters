import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fingerprintPath } from "./hash.js";
import { importWithAsm, pushWithAsm } from "./asm.js";
import { loadState, saveState, withLock } from "./state.js";
import type { ImportResult, Provider, SyncConfig, SyncSummary } from "./types.js";

export interface SyncOptions {
  push: boolean;
  sources?: string[];
}

export async function syncOnce(config: SyncConfig, options: SyncOptions): Promise<SyncSummary> {
  return await withLock(config.dataRoot, async () => {
    const statePath = join(config.dataRoot, "state.json");
    const state = await loadState(statePath);
    const sources = options.sources ?? await discoverSources(config.dataRoot);
    const results: ImportResult[] = [];

    for (const candidate of sources) {
      const source = resolve(candidate);
      const fingerprint = await fingerprintPath(source);
      const previous = state.sources[source];
      if (previous?.fingerprint === fingerprint) {
        results.push({
          source,
          status: "unchanged",
          ...(previous.provider ? { provider: previous.provider } : {}),
          candidates: 0,
          newVersions: 0,
        });
        continue;
      }

      const provider = providerFromLivePath(config.dataRoot, source);
      const result = await importWithAsm(config, source, provider);
      results.push(result);
      state.sources[source] = {
        fingerprint,
        status: result.status === "unsupported" ? "unsupported" : "imported",
        ...(result.provider ? { provider: result.provider } : {}),
        checkedAt: new Date().toISOString(),
      };
      await saveState(statePath, state);
    }

    let pushed = false;
    let pushObjects = 0;
    let pushBytes = 0;
    if (options.push) {
      const push = await pushWithAsm(config);
      pushed = true;
      pushObjects = push.objects;
      pushBytes = push.bytes;
    }

    return summarize(results, { pushed, pushObjects, pushBytes });
  });
}

export async function discoverSources(dataRoot: string): Promise<string[]> {
  const sources = [
    ...await children(join(dataRoot, "incoming")),
    ...await children(join(dataRoot, "live")),
  ];
  return sources.sort((left, right) => left.localeCompare(right));
}

function summarize(
  results: ImportResult[],
  push: Pick<SyncSummary, "pushed" | "pushObjects" | "pushBytes">,
): SyncSummary {
  return {
    scanned: results.length,
    imported: results.filter((result) => result.status === "imported").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    unsupported: results.filter((result) => result.status === "unsupported").length,
    candidates: results.reduce((sum, result) => sum + result.candidates, 0),
    newVersions: results.reduce((sum, result) => sum + result.newVersions, 0),
    ...push,
  };
}

async function children(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path);
    const output: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const candidate = join(path, entry);
      const metadata = await stat(candidate);
      if (metadata.isFile() || metadata.isDirectory()) output.push(candidate);
    }
    return output;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function providerFromLivePath(dataRoot: string, source: string): Provider | undefined {
  const liveRoot = resolve(dataRoot, "live");
  if (!source.startsWith(`${liveRoot}/`)) return undefined;
  const name = source.slice(liveRoot.length + 1).split("/")[0];
  const aliases: Record<string, Provider> = {
    chatgpt: "chatgpt-web",
    "chatgpt-web": "chatgpt-web",
    claude: "claude-web",
    "claude-web": "claude-web",
    gemini: "gemini-web",
    "gemini-web": "gemini-web",
    grok: "grok-web",
    "grok-web": "grok-web",
    "ai-studio": "google-ai-studio",
    "google-ai-studio": "google-ai-studio",
  };
  return name ? aliases[name] : undefined;
}
