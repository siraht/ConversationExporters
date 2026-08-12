import { resolve } from "node:path";
import { NodeArchiveFileSystem } from "@conversation-exporters/shared/node-filesystem";
import { auditArchive } from "../chatgpt/audit";

const root = process.argv[2];
if (!root) {
  console.error("Usage: chatgpt-audit PATH_TO_CHATGPT_EXPORT");
  process.exit(2);
}

const report = await auditArchive({
  filesystem: new NodeArchiveFileSystem(resolve(root)),
  extensionVersion: "local-audit-v1",
});
const findingCodes: Record<string, number> = {};
for (const finding of report.findings) findingCodes[finding.code] = (findingCodes[finding.code] ?? 0) + 1;
console.log(JSON.stringify({
  terminalState: report.terminalState,
  expectedConversationCount: report.expectedConversationCount,
  completeConversationCount: report.completeConversationCount,
  extraRetainedConversationCount: report.extraRetainedConversationCount,
  partialAssetReferenceCount: report.partialAssetReferenceCount,
  archiveBytes: report.archiveBytes,
  findingCodes,
}));
if (report.terminalState === "incomplete") process.exitCode = 1;
