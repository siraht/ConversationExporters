#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

try {
  const root = option("--archive-root");
  const inventory = await json(path.join(root, "inventory.json"));
  const report = await json(path.join(root, "reports", "validation.json"));
  const inventoryIds = new Set((inventory.conversations ?? []).map((conversation) => String(conversation.id)));
  const conversationRoot = path.join(root, "conversations");
  const directoryEntries = await readdir(conversationRoot, { withFileTypes: true });
  const directoryIds = new Set(directoryEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const indexIds = new Set((await readFile(path.join(root, "indexes", "conversations.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => String(JSON.parse(line).id)));
  const validationIds = new Set();
  const markerIds = new Set();
  let normalizedHashMismatches = 0;
  let invalidValidations = 0;
  let missingRawSourcePaths = 0;
  let completeAssetRecords = 0;
  let verifiedAssetRecords = 0;
  let assetMismatchCount = 0;

  for (const conversationId of directoryIds) {
    const base = path.join(conversationRoot, conversationId);
    const validation = await json(path.join(base, "validation.json"));
    const marker = await json(path.join(base, "complete.json"));
    const normalized = await json(path.join(base, "conversation.json"));
    const assets = await json(path.join(base, "assets.json"));
    validationIds.add(String(validation.conversationId));
    markerIds.add(String(marker.conversationId));
    if (validation.valid !== true || marker.validationValid !== true) invalidValidations += 1;
    if (marker.normalizedHash !== hashJson(normalized)) normalizedHashMismatches += 1;
    for (const sourcePath of normalized.provenance?.sourcePaths ?? []) {
      if (!await isFile(path.join(base, String(sourcePath)))) missingRawSourcePaths += 1;
    }
    for (const record of assets.records ?? []) {
      if (record.status !== "complete") continue;
      completeAssetRecords += 1;
      if (typeof record.localPath !== "string" || typeof record.contentHash !== "string" || typeof record.size !== "number") {
        assetMismatchCount += 1;
        continue;
      }
      const filename = path.join(root, record.localPath);
      try {
        const bytes = await readFile(filename);
        const size = (await stat(filename)).size;
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (size === record.size && hash === record.contentHash) verifiedAssetRecords += 1;
        else assetMismatchCount += 1;
      } catch {
        assetMismatchCount += 1;
      }
    }
  }

  const result = {
    schema: "grok-exporter-private-archive-audit/1",
    inventoryCount: inventoryIds.size,
    directoryCount: directoryIds.size,
    indexCount: indexIds.size,
    validationCount: validationIds.size,
    completionMarkerCount: markerIds.size,
    conversationSetsEqual: equalSets(inventoryIds, directoryIds, indexIds, validationIds, markerIds),
    normalizedHashMismatches,
    invalidValidations,
    missingRawSourcePaths,
    completeAssetRecords,
    verifiedAssetRecords,
    assetMismatchCount,
    reportComplete: report.summary?.complete === true,
    reportFailureCount: Number(report.summary?.failedCount ?? -1),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.conversationSetsEqual || normalizedHashMismatches !== 0 || invalidValidations !== 0
    || missingRawSourcePaths !== 0 || assetMismatchCount !== 0 || !result.reportComplete
    || result.reportFailureCount !== 0) process.exitCode = 1;
} catch {
  console.error("Private archive audit failed; verify the archive structure and permissions.");
  process.exitCode = 1;
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

async function json(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function isFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}

function equalSets(...sets) {
  const [first, ...rest] = sets;
  return rest.every((candidate) => first.size === candidate.size && [...first].every((value) => candidate.has(value)));
}

function hashJson(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
