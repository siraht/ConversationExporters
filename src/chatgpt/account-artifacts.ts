import type { ArchiveFileSystem } from "../core/filesystem";
import { sha256Hex } from "../core/hash";
import { parseJson, prettyJson } from "../core/serialization";
import type { JsonValue, SafeFailure } from "../core/types";
import type { ChatGptTransport, DiscoveredWorkspace } from "./client";

export interface AccountArtifactManifest {
  schemaVersion: 1;
  provider: "chatgpt-web";
  workspaceFingerprint: string;
  capturedAt: string;
  status: "complete" | "partial";
  artifacts: Array<{
    kind: "memories" | "custom_instructions" | "settings" | "beta_features" | "session_metadata";
    status: "complete" | "failed";
    hash: string | null;
    currentPath: string | null;
    revisionPath: string | null;
    failure?: SafeFailure;
  }>;
}

export class AccountArtifactCapture {
  constructor(private readonly options: {
    transport: ChatGptTransport;
    filesystem: ArchiveFileSystem;
    workspace: DiscoveredWorkspace;
    now?: () => Date;
  }) {}

  async capture(refresh = false): Promise<AccountArtifactManifest> {
    const existing = await this.validManifest();
    if (existing && !refresh) return existing;
    const capturedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const artifacts: AccountArtifactManifest["artifacts"] = [];
    const sessionMetadata: JsonValue = {
      provider: "chatgpt-web",
      workspaceFingerprint: this.options.workspace.workspaceFingerprint,
      workspaceKind: this.options.workspace.kind,
      capturedAt,
    };
    artifacts.push(await this.persist("session_metadata", sessionMetadata, "session-metadata"));
    for (const kind of ["memories", "custom_instructions", "settings", "beta_features"] as const) {
      try {
        const response = await this.options.transport.request({ operation: "account_artifact", parameters: { kind } }, this.options.workspace.accountId);
        artifacts.push(await this.persist(kind, response.body, kind.replaceAll("_", "-")));
      } catch (error) {
        artifacts.push({ kind, status: "failed", hash: null, currentPath: null, revisionPath: null, failure: safeFailure(error) });
      }
    }
    const manifest: AccountArtifactManifest = {
      schemaVersion: 1,
      provider: "chatgpt-web",
      workspaceFingerprint: this.options.workspace.workspaceFingerprint,
      capturedAt,
      status: artifacts.some((artifact) => artifact.status === "failed") ? "partial" : "complete",
      artifacts,
    };
    await this.options.filesystem.writeTextAtomic("source/account/artifacts-complete.json", prettyJson(manifest));
    return manifest;
  }

  private async persist(kind: AccountArtifactManifest["artifacts"][number]["kind"], value: JsonValue, filename: string) {
    const content = prettyJson(value);
    const hash = await sha256Hex(content);
    const revisionPath = `source/account/${filename}-${hash}.json`;
    const currentPath = `source/account/${filename}.json`;
    if (!await this.options.filesystem.exists(revisionPath)) await this.options.filesystem.writeTextAtomic(revisionPath, content);
    await this.options.filesystem.writeTextAtomic(currentPath, content);
    return { kind, status: "complete" as const, hash, currentPath, revisionPath };
  }

  private async validManifest(): Promise<AccountArtifactManifest | undefined> {
    const manifest = parseJson<AccountArtifactManifest>(await this.options.filesystem.readText("source/account/artifacts-complete.json"));
    if (!manifest || manifest.schemaVersion !== 1 || manifest.provider !== "chatgpt-web" || manifest.workspaceFingerprint !== this.options.workspace.workspaceFingerprint) return undefined;
    for (const artifact of manifest.artifacts) {
      if (artifact.status !== "complete") continue;
      if (!artifact.hash || !artifact.currentPath || !artifact.revisionPath) return undefined;
      for (const path of [artifact.currentPath, artifact.revisionPath]) {
        const content = await this.options.filesystem.readText(path);
        if (content === undefined || await sha256Hex(content) !== artifact.hash) return undefined;
      }
    }
    return manifest;
  }
}

function safeFailure(error: unknown): SafeFailure {
  const candidate = error as { code?: unknown; retryable?: unknown; correlationId?: unknown } | null;
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "ACCOUNT_ARTIFACT_FAILED",
    message: error instanceof Error ? error.message : "Account artifact capture failed.",
    retryable: candidate?.retryable === true,
    correlationId: typeof candidate?.correlationId === "string" ? candidate.correlationId : crypto.randomUUID(),
  };
}
