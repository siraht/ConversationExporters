import type { NormalizedContentPart, NormalizedConversation, NormalizedMessage } from "./types";

export function renderConversationMarkdown(conversation: NormalizedConversation): string {
  const lines = [
    `# ${escapeText(conversation.title ?? "Untitled conversation")}`,
    "",
    `- Provider: ChatGPT Web`,
    `- Conversation ID: \`${escapeCode(conversation.conversationId)}\``,
    `- Workspace: \`${conversation.workspaceFingerprint}\``,
    "",
    "## Selected branch",
    "",
  ];
  const selected = selectedMessages(conversation);
  for (const message of selected) lines.push(...renderMessage(message));
  const selectedIds = new Set(selected.map((message) => message.id));
  const alternatives = conversation.messages.filter((message) => !selectedIds.has(message.id)).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (alternatives.length) {
    lines.push("## Alternative branches", "");
    for (const message of alternatives) lines.push(...renderMessage(message));
  }
  if (conversation.findings.length) {
    lines.push("## Validation findings", "");
    for (const finding of conversation.findings) lines.push(`- **${finding.severity.toUpperCase()} · ${escapeText(finding.code)}:** ${escapeText(finding.message)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function selectedMessages(conversation: NormalizedConversation): NormalizedMessage[] {
  const byNode = new Map(conversation.messages.map((message) => [message.nodeId, message]));
  const nodes = new Map(conversation.nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current = conversation.currentNodeId;
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = nodes.get(current)?.parentId ?? null;
  }
  return path.reverse().flatMap((nodeId) => byNode.get(nodeId) ?? []);
}

function renderMessage(message: NormalizedMessage): string[] {
  const label = message.authorName ? `${message.role} · ${message.authorName}` : message.role;
  const lines = [`### ${escapeText(label)} {#message-${safeAnchor(message.id)}}`, "", `<!-- node:${escapeText(message.nodeId)} -->`, ""];
  for (const part of message.parts) lines.push(...renderPart(part));
  return [...lines, ""];
}

function renderPart(part: NormalizedContentPart): string[] {
  if (part.kind === "text") return [escapeText(part.text ?? ""), ""];
  if (part.kind === "code") {
    const fence = codeFence(part.text ?? "");
    return [`${fence}${part.language ?? ""}`, part.text ?? "", fence, ""];
  }
  if (["execution_output", "tool_call", "tool_result", "reasoning_summary", "deep_research", "canvas"].includes(part.kind)) {
    return [`**${part.kind.replaceAll("_", " ")}**`, "", escapeText(part.text ?? ""), ""];
  }
  if (part.kind === "citation") {
    const label = escapeText(part.title ?? part.text ?? part.url ?? "Citation");
    return [part.url ? `[${label}](${part.url})` : label, ""];
  }
  if (part.kind === "asset") {
    const label = `Asset: ${escapeText(part.assetId ?? "unresolved")}`;
    return [part.assetPath ? `[${label}](${part.assetPath})` : `[${label}]`, ""];
  }
  return ["```json", JSON.stringify(part.raw, null, 2), "```", ""];
}

function codeFence(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeCode(value: string): string {
  return value.replaceAll("`", "\\`");
}

function safeAnchor(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}
