import type { ConversationCompletionMarker } from "./capture-engine";
import type { RawCompletionMarker } from "../core/capture-store";
import type { ArchiveFileSystem } from "../core/filesystem";
import { sha256Hex } from "../core/hash";
import { conversationBasePath } from "../core/paths";
import { IncrementalSha256 } from "../core/sha256-stream";
import { parseJson, prettyJson } from "../core/serialization";
import type {
  ArchiveManifest,
  AssetRecord,
  ConversationAssetIndex,
  ConversationInventory,
  NormalizedConversation,
  ProjectAssetIndex,
} from "../core/types";

export interface ArchiveAuditFinding {
  severity: "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface ArchiveAuditReport {
  schemaVersion: 1;
  provider: "chatgpt-web";
  workspaceFingerprint: string;
  auditedAt: string;
  terminalState: "complete" | "conversations_complete_assets_partial" | "incomplete";
  expectedConversationCount: number;
  completeConversationCount: number;
  extraRetainedConversationCount: number;
  projectCount: number;
  logicalAssetReferenceCount: number;
  physicalAssetCount: number;
  partialAssetReferenceCount: number;
  archiveBytes: number;
  assetBytes: number;
  inventorySetHash: string;
  completionSetHash: string;
  normalizedSetHash: string;
  conversationsIndexHash: string;
  assetsIndexHash: string;
  findings: ArchiveAuditFinding[];
}

export async function auditArchive(options: {
  filesystem: ArchiveFileSystem;
  extensionVersion: string;
  now?: () => Date;
}): Promise<ArchiveAuditReport> {
  const { filesystem } = options;
  const inventory = parseJson<ConversationInventory>(await filesystem.readText("inventory.json"));
  if (!inventory || inventory.schemaVersion !== 1 || inventory.provider !== "chatgpt-web" || !inventory.complete) {
    throw new Error("A complete ChatGPT inventory is required for archive audit.");
  }
  const findings: ArchiveAuditFinding[] = [];
  const allPaths = await filesystem.listPaths();
  const completionPaths = allPaths.filter((path) => /^conversations\/[^/]+\/complete\.json$/.test(path));
  const normalizedPaths = allPaths.filter((path) => /^conversations\/[^/]+\/conversation\.json$/.test(path));
  const expectedIds = inventory.conversations.map((item) => item.conversationId).sort();
  const expectedPathById = new Map(inventory.conversations.map((item) => [item.conversationId, `${conversationBasePath(item.conversationId)}/complete.json`]));
  const completionIds: string[] = [];
  const normalizedIds: string[] = [];
  const conversationRows: Array<Record<string, unknown>> = [];
  let partialAssetReferenceCount = 0;
  let logicalAssetReferenceCount = 0;

  for (const conversation of inventory.conversations) {
    const base = conversationBasePath(conversation.conversationId);
    const markerPath = `${base}/complete.json`;
    const marker = parseJson<ConversationCompletionMarker>(await filesystem.readText(markerPath));
    if (!marker) {
      findings.push(error("CONVERSATION_COMPLETION_MISSING", "Expected conversation has no readable completion marker.", markerPath));
      continue;
    }
    completionIds.push(conversation.conversationId);
    const rawMarkerPath = `${base}/raw-complete.json`;
    const normalizedPath = `${base}/conversation.json`;
    const markdownPath = `${base}/conversation.md`;
    const assetsPath = `${base}/assets.json`;
    const rawMarkerText = await filesystem.readText(rawMarkerPath);
    const normalizedText = await filesystem.readText(normalizedPath);
    const markdownText = await filesystem.readText(markdownPath);
    const assetsText = await filesystem.readText(assetsPath);
    const identitiesMatch = marker.schemaVersion === 1
      && marker.provider === "chatgpt-web"
      && marker.logicalKey === conversation.logicalKey
      && marker.conversationId === conversation.conversationId
      && marker.workspaceFingerprint === inventory.workspaceFingerprint;
    if (!identitiesMatch) findings.push(error("CONVERSATION_COMPLETION_IDENTITY", "Completion marker identity does not match inventory.", markerPath));
    await verifyTextHash(rawMarkerText, marker.rawMarkerHash, rawMarkerPath, findings);
    await verifyTextHash(normalizedText, marker.normalizedHash, normalizedPath, findings);
    await verifyTextHash(markdownText, marker.markdownHash, markdownPath, findings);
    await verifyTextHash(assetsText, marker.assetsHash, assetsPath, findings);
    if (normalizedText !== undefined) normalizedIds.push(conversation.conversationId);

    const rawMarker = parseJson<RawCompletionMarker>(rawMarkerText);
    const normalized = parseJson<NormalizedConversation>(normalizedText);
    if (!rawMarker || !isNormalizedConversation(normalized)) {
      findings.push(error("CONVERSATION_DERIVED_INVALID", "Raw completion or normalized conversation JSON is invalid.", base));
    } else {
      await verifyRawGraph(filesystem, rawMarker, normalized, findings);
      conversationRows.push({
        logicalKey: conversation.logicalKey,
        conversationId: conversation.conversationId,
        title: normalized.title,
        createTime: normalized.createTime,
        updateTime: normalized.updateTime,
        memberships: normalized.memberships,
        normalizedPath,
        rawPath: rawMarker.detailPath,
        normalizedHash: marker.normalizedHash,
        assetStatus: marker.assetStatus,
      });
    }
    const assets = parseJson<ConversationAssetIndex>(assetsText);
    if (!assets || !Array.isArray(assets.assets)) findings.push(error("ASSET_INDEX_INVALID", "Conversation asset index is invalid.", assetsPath));
    else {
      logicalAssetReferenceCount += assets.assets.length;
      partialAssetReferenceCount += assets.assets.filter((asset) => asset.status === "failed").length;
      await verifyAssets(filesystem, assets.assets, findings);
    }
  }

  for (const project of inventory.projects ?? []) {
    const path = `projects/${project.projectId}/assets.json`;
    const index = parseJson<ProjectAssetIndex>(await filesystem.readText(path));
    if (!index || !Array.isArray(index.assets)) {
      findings.push(error("PROJECT_ASSET_INDEX_MISSING", "Inventoried project has no readable asset index.", path));
      continue;
    }
    logicalAssetReferenceCount += index.assets.length;
    partialAssetReferenceCount += index.assets.filter((asset) => asset.status === "failed").length;
    await verifyAssets(filesystem, index.assets, findings);
  }

  for (const path of completionPaths) {
    if (![...expectedPathById.values()].includes(path)) {
      const marker = parseJson<ConversationCompletionMarker>(await filesystem.readText(path));
      if (!marker?.conversationId) {
        findings.push(error("RETAINED_COMPLETION_INVALID", "Retained completion marker is not readable.", path));
        continue;
      }
      const base = path.replace(/\/complete\.json$/, "");
      const normalizedPath = `${base}/conversation.json`;
      const rawMarkerPath = `${base}/raw-complete.json`;
      const normalizedText = await filesystem.readText(normalizedPath);
      const rawMarkerText = await filesystem.readText(rawMarkerPath);
      const assetsText = await filesystem.readText(`${base}/assets.json`);
      await verifyTextHash(rawMarkerText, marker.rawMarkerHash, rawMarkerPath, findings);
      await verifyTextHash(normalizedText, marker.normalizedHash, normalizedPath, findings);
      await verifyTextHash(assetsText, marker.assetsHash, `${base}/assets.json`, findings);
      const normalized = parseJson<NormalizedConversation>(normalizedText);
      const rawMarker = parseJson<RawCompletionMarker>(rawMarkerText);
      if (!isNormalizedConversation(normalized) || !rawMarker) {
        findings.push(error("RETAINED_CONVERSATION_INVALID", "Retained conversation raw or normalized record is invalid.", base));
        continue;
      }
      await verifyRawGraph(filesystem, rawMarker, normalized, findings);
      conversationRows.push({
        logicalKey: marker.logicalKey,
        conversationId: marker.conversationId,
        title: normalized.title,
        createTime: normalized.createTime,
        updateTime: normalized.updateTime,
        memberships: normalized.memberships,
        normalizedPath,
        rawPath: rawMarker.detailPath,
        normalizedHash: marker.normalizedHash,
        assetStatus: marker.assetStatus,
        absentFromCurrentInventory: true,
      });
      const assets = parseJson<ConversationAssetIndex>(assetsText);
      if (assets && Array.isArray(assets.assets)) {
        logicalAssetReferenceCount += assets.assets.length;
        partialAssetReferenceCount += assets.assets.filter((asset) => asset.status === "failed").length;
        await verifyAssets(filesystem, assets.assets, findings);
      }
    }
  }
  for (const path of allPaths.filter((candidate) => candidate.startsWith("staging/") || candidate.endsWith(".part"))) {
    findings.push(error("TEMPORARY_FILE_REMAINS", "A temporary or partial file remains in the archive.", path));
  }

  conversationRows.sort((left, right) => String(left.logicalKey).localeCompare(String(right.logicalKey)));
  const conversationsIndexText = jsonl(conversationRows);
  await filesystem.writeTextAtomic("indexes/conversations.jsonl", conversationsIndexText);
  const assetsIndexText = await filesystem.readText("indexes/assets.jsonl") ?? "";
  const measuredPaths = await filesystem.listPaths();
  const physicalAssetPaths = measuredPaths.filter((path) => path.startsWith("assets/"));
  let archiveBytes = 0;
  let assetBytes = 0;
  for (const path of measuredPaths) {
    const size = await byteSize(filesystem, path);
    archiveBytes += size;
    if (path.startsWith("assets/")) assetBytes += size;
  }
  const expectedSet = unique(expectedIds);
  const completionSet = unique(completionIds.filter((id) => expectedIds.includes(id)));
  const normalizedSet = unique(normalizedIds);
  if (!sameSet(expectedSet, completionSet)) findings.push(error("COMPLETION_SET_MISMATCH", "Inventory and completion-marker sets differ."));
  if (!sameSet(expectedSet, normalizedSet)) findings.push(error("NORMALIZED_SET_MISMATCH", "Inventory and normalized-conversation sets differ."));

  const conversationErrors = findings.filter((finding) => finding.severity === "error" && !finding.code.startsWith("ASSET_") && !finding.code.startsWith("PROJECT_ASSET_"));
  const terminalState = conversationErrors.length > 0
    ? "incomplete" as const
    : partialAssetReferenceCount > 0 || findings.some((finding) => finding.severity === "error")
      ? "conversations_complete_assets_partial" as const
      : "complete" as const;
  const report: ArchiveAuditReport = {
    schemaVersion: 1,
    provider: "chatgpt-web",
    workspaceFingerprint: inventory.workspaceFingerprint,
    auditedAt: (options.now ?? (() => new Date()))().toISOString(),
    terminalState,
    expectedConversationCount: expectedSet.length,
    completeConversationCount: completionSet.length,
    extraRetainedConversationCount: Math.max(0, completionPaths.length - completionSet.length),
    projectCount: inventory.projects?.length ?? 0,
    logicalAssetReferenceCount,
    physicalAssetCount: physicalAssetPaths.length,
    partialAssetReferenceCount,
    archiveBytes,
    assetBytes,
    inventorySetHash: await setHash(expectedSet),
    completionSetHash: await setHash(completionSet),
    normalizedSetHash: await setHash(normalizedSet),
    conversationsIndexHash: await sha256Hex(conversationsIndexText),
    assetsIndexHash: await sha256Hex(assetsIndexText),
    findings,
  };
  await filesystem.writeTextAtomic("reports/validation.json", prettyJson(report));
  await filesystem.writeTextAtomic("reports/validation.md", renderValidation(report));
  const previousManifest = parseJson<ArchiveManifest>(await filesystem.readText("archive.json"));
  const manifest: ArchiveManifest = {
    schemaVersion: 1,
    provider: "chatgpt-web",
    workspaceFingerprint: inventory.workspaceFingerprint,
    selectedScopes: unique(inventory.chains.map((chain) => chain.scope)),
    extensionVersion: options.extensionVersion,
    normalizerVersion: conversationRows.length ? String((parseJson<NormalizedConversation>(await filesystem.readText(String(conversationRows[0]!.normalizedPath)))?.normalizerVersion) ?? "unknown") : "unknown",
    createdAt: previousManifest?.createdAt ?? report.auditedAt,
    updatedAt: report.auditedAt,
    runIds: unique((await filesystem.listPaths("runs")).map((path) => path.split("/").at(-1)?.replace(/\.json$/, "") ?? "").filter(Boolean)),
    currentIndexHashes: {
      conversations: report.conversationsIndexHash,
      assets: report.assetsIndexHash,
      inventorySet: report.inventorySetHash,
      completionSet: report.completionSetHash,
    },
  };
  await filesystem.writeTextAtomic("archive.json", prettyJson(manifest));
  return report;
}

async function verifyRawGraph(
  filesystem: ArchiveFileSystem,
  rawMarker: RawCompletionMarker,
  normalized: NormalizedConversation,
  findings: ArchiveAuditFinding[],
): Promise<void> {
  const rawText = await filesystem.readText(rawMarker.detailPath);
  if (rawText === undefined || await sha256Hex(rawText) !== rawMarker.detailHash) {
    findings.push(error("RAW_DETAIL_HASH_MISMATCH", "Raw conversation detail is missing or does not match its marker.", rawMarker.detailPath));
    return;
  }
  const raw = parseJson<{ mapping?: Record<string, { message?: { id?: string } | null }> }>(rawText);
  if (!raw?.mapping || typeof raw.mapping !== "object") {
    findings.push(error("RAW_GRAPH_INVALID", "Raw detail has no readable mapping.", rawMarker.detailPath));
    return;
  }
  const rawNodeIds = Object.keys(raw.mapping).sort();
  const normalizedNodeIds = normalized.nodes.map((node) => node.id).sort();
  if (!sameSet(rawNodeIds, normalizedNodeIds)) findings.push(error("GRAPH_NODE_SET_MISMATCH", "Raw and normalized graph-node sets differ.", rawMarker.detailPath));
  const rawMessageIds = Object.values(raw.mapping).flatMap((node) => typeof node?.message?.id === "string" ? [node.message.id] : []).sort();
  const normalizedMessageIds = normalized.messages.map((message) => message.id).sort();
  if (!sameSet(rawMessageIds, normalizedMessageIds)) findings.push(error("GRAPH_MESSAGE_SET_MISMATCH", "Raw and normalized message sets differ.", rawMarker.detailPath));
}

async function verifyAssets(filesystem: ArchiveFileSystem, assets: AssetRecord[], findings: ArchiveAuditFinding[]): Promise<void> {
  for (const asset of assets) {
    if (asset.status === "failed") continue;
    if (asset.status === "not_requested") continue;
    if (asset.status !== "complete" || !asset.relativePath || !asset.sha256 || asset.byteSize === null) {
      findings.push(error("ASSET_RECORD_INCOMPLETE", "Completed asset record lacks a path, hash, or byte size."));
      continue;
    }
    const path = asset.relativePath.replace(/^\.\.\/\.\.\//, "");
    if (!path.startsWith("assets/")) {
      findings.push(error("ASSET_PATH_INVALID", "Asset path does not resolve inside the archive asset store."));
      continue;
    }
    const actual = await hashAndSize(filesystem, path).catch(() => null);
    if (!actual || actual.sha256 !== asset.sha256 || actual.byteSize !== asset.byteSize) {
      findings.push(error("ASSET_HASH_MISMATCH", "Asset bytes do not match the logical reference.", path));
    } else if (actual.byteSize === 0) {
      findings.push(error("ASSET_ZERO_BYTES", "Downloaded asset is empty.", path));
    }
  }
}

async function verifyTextHash(value: string | undefined, expected: string, path: string, findings: ArchiveAuditFinding[]): Promise<void> {
  if (value === undefined || await sha256Hex(value) !== expected) findings.push(error("DERIVED_HASH_MISMATCH", "Required archive text is missing or has the wrong hash.", path));
}

async function hashAndSize(filesystem: ArchiveFileSystem, path: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = new IncrementalSha256();
  let byteSize = 0;
  for await (const chunk of filesystem.readByteChunks(path)) {
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  return { sha256: hash.digestHex(), byteSize };
}

async function byteSize(filesystem: ArchiveFileSystem, path: string): Promise<number> {
  const size = await filesystem.byteSize(path);
  if (size === undefined) throw new Error(`Archive file disappeared during audit: ${path}`);
  return size;
}

function error(code: string, message: string, path?: string): ArchiveAuditFinding {
  return { severity: "error", code, message, ...(path === undefined ? {} : { path }) };
}

function isNormalizedConversation(value: NormalizedConversation | undefined): value is NormalizedConversation {
  return value?.schemaVersion === 1
    && value.provider === "chatgpt-web"
    && Array.isArray(value.nodes)
    && Array.isArray(value.messages)
    && Array.isArray(value.memberships);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function setHash(values: string[]): Promise<string> {
  return sha256Hex(values.join("\n"));
}

function jsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

function renderValidation(report: ArchiveAuditReport): string {
  const lines = [
    "# ChatGPTExporter validation",
    "",
    `Terminal state: **${report.terminalState}**`,
    "",
    `- Expected conversations: ${report.expectedConversationCount}`,
    `- Complete conversations: ${report.completeConversationCount}`,
    `- Retained conversations absent from current inventory: ${report.extraRetainedConversationCount}`,
    `- Projects: ${report.projectCount}`,
    `- Logical asset references: ${report.logicalAssetReferenceCount}`,
    `- Partial asset references: ${report.partialAssetReferenceCount}`,
    `- Physical assets: ${report.physicalAssetCount}`,
    `- Archive bytes audited: ${report.archiveBytes}`,
    `- Asset bytes audited: ${report.assetBytes}`,
    "",
    "## Set hashes",
    "",
    `- Inventory: \`${report.inventorySetHash}\``,
    `- Completion markers: \`${report.completionSetHash}\``,
    `- Normalized conversations: \`${report.normalizedSetHash}\``,
    "",
    "## Findings",
    "",
    ...(report.findings.length ? report.findings.map((finding) => `- ${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}${finding.path ? ` (\`${finding.path}\`)` : ""}`) : ["- None."]),
    "",
  ];
  return lines.join("\n");
}
