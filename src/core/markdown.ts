import type { ConversationValidation, NormalizedConversation, NormalizedMessage } from "./types";

export function renderConversationMarkdown(conversation: NormalizedConversation, validation?: ConversationValidation): string {
  const lines: string[] = [
    "---",
    `title: "${escapeYaml(conversation.title)}"`,
    'provider: "grok"',
    `conversation_id: "${escapeYaml(conversation.id)}"`,
    `source_url: "${escapeYaml(conversation.sourceUrl)}"`,
    `captured_at: "${escapeYaml(conversation.capturedAt)}"`,
    `message_count: ${conversation.messages.length}`,
    `root_message_count: ${conversation.rootMessageIds.length}`,
    `validation: "${validation?.valid === false ? "failed" : "passed"}"`,
  ];
  if (conversation.createdAt) lines.push(`created_at: "${escapeYaml(conversation.createdAt)}"`);
  if (conversation.updatedAt) lines.push(`updated_at: "${escapeYaml(conversation.updatedAt)}"`);
  if (conversation.workspaceIds.length) lines.push(`workspace_ids: [${conversation.workspaceIds.map((id) => `"${escapeYaml(id)}"`).join(", ")}]`);
  lines.push("---", "", `# ${conversation.title}`, "", `[Open in Grok](${conversation.sourceUrl})`, "");

  for (const message of conversation.messages) lines.push(...renderMessage(message));

  const findings = validation?.findings ?? conversation.warnings;
  if (findings.length) {
    lines.push("## Export notes", "");
    for (const finding of findings) lines.push(`- **${finding.severity.toUpperCase()} · ${finding.code}:** ${finding.message}`);
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function renderMessage(message: NormalizedMessage): string[] {
  const role = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  const lines = [
    `<a id="message-${escapeHtmlAttribute(message.id)}"></a>`,
    `## ${role} · ${message.id}`,
    "",
  ];
  const metadata = [
    message.createdAt ? `time: ${message.createdAt}` : undefined,
    message.model ? `model: ${message.model}` : undefined,
    message.parentId ? `parent: [${message.parentId}](#message-${encodeURIComponent(message.parentId)})` : undefined,
    message.childIds.length ? `children: ${message.childIds.map((id) => `[${id}](#message-${encodeURIComponent(id)})`).join(", ")}` : undefined,
    message.selected === undefined ? undefined : `selected: ${String(message.selected)}`,
  ].filter((value): value is string => Boolean(value));
  if (metadata.length) lines.push(`_${metadata.join(" · ")}_`, "");
  if (message.markdown) lines.push(message.markdown.trim(), "");

  if (message.attachments.length) {
    lines.push("### Attachments", "");
    message.attachments.forEach((attachment, index) => {
      const label = attachment.name ?? attachment.id ?? `${attachment.kind} ${index + 1}`;
      const target = attachment.localPath ?? attachment.sourceUrl;
      lines.push(target ? `- [${escapeLinkLabel(label)}](${encodeLinkTarget(target)})` : `- ${escapeLinkLabel(label)} (${attachment.kind}; unavailable)`);
    });
    lines.push("");
  }

  if (message.citations.length) {
    lines.push("### Sources", "");
    message.citations.forEach((citation, index) => {
      lines.push(`- [${escapeLinkLabel(citation.title ?? `Source ${index + 1}`)}](${encodeLinkTarget(citation.url)})`);
    });
    lines.push("");
  }
  return lines;
}

function escapeYaml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeLinkLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeLinkTarget(value: string): string {
  return value.replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29");
}

