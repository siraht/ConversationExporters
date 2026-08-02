import type {
  ConversationInventory,
  ConversationValidation,
  NormalizedConversation,
  RawConversationCapture,
  ValidationFinding,
} from "./types";
import { capturedResponses } from "../grok/client";
import { collectResponseIds, responseNodesFromEnvelope } from "../grok/envelopes";

export function validateConversationCapture(
  capture: RawConversationCapture,
  conversation: NormalizedConversation,
  priorFindings: ValidationFinding[] = [],
): ConversationValidation {
  const expected = collectResponseIds(responseNodesFromEnvelope(capture.responseNodes));
  const captured = collectResponseIds(capturedResponses(capture));
  const expectedSet = new Set(expected.ids);
  const capturedSet = new Set(captured.ids);
  const missingResponseIds = expected.ids.filter((id) => !capturedSet.has(id));
  const unexpectedResponseIds = captured.ids.filter((id) => !expectedSet.has(id));
  const duplicateResponseIds = captured.findings
    .filter((finding) => finding.code === "RESPONSE_ID_DUPLICATE" && finding.responseId)
    .map((finding) => finding.responseId as string);
  const findings = [...priorFindings, ...expected.findings, ...captured.findings, ...conversation.warnings];

  for (const responseId of missingResponseIds) {
    findings.push({
      code: "RESPONSE_BODY_MISSING",
      severity: "error",
      message: `Expected response ${responseId} was not captured.`,
      conversationId: conversation.id,
      responseId,
    });
  }
  for (const responseId of unexpectedResponseIds) {
    findings.push({
      code: "RESPONSE_BODY_UNEXPECTED",
      severity: "warning",
      message: `Captured response ${responseId} was absent from the response-node graph.`,
      conversationId: conversation.id,
      responseId,
    });
  }

  findings.push(...validateGraph(conversation));
  const deduped = dedupeFindings(findings);
  return {
    conversationId: conversation.id,
    valid: !deduped.some((finding) => finding.severity === "error"),
    expectedResponseIds: expected.ids,
    capturedResponseIds: captured.ids,
    missingResponseIds,
    unexpectedResponseIds,
    duplicateResponseIds,
    findings: deduped,
  };
}

export function validateInventory(inventory: ConversationInventory): ValidationFinding[] {
  const findings = [...inventory.warnings];
  if (!inventory.complete) {
    findings.push({
      code: "INVENTORY_INCOMPLETE",
      severity: "error",
      message: "Conversation inventory did not complete cleanly.",
    });
  }
  if (inventory.pages.length === 0) {
    findings.push({ code: "INVENTORY_EMPTY", severity: "error", message: "Inventory contains no page evidence." });
  }
  const lastPage = inventory.pages.at(-1);
  if (lastPage?.returnedPageToken) {
    findings.push({
      code: "INVENTORY_TOKEN_REMAINS",
      severity: "error",
      message: "Inventory ended while a next-page token remained.",
    });
  }
  return dedupeFindings(findings);
}

function validateGraph(conversation: NormalizedConversation): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const byId = new Map(conversation.messages.map((message) => [message.id, message]));
  for (const message of conversation.messages) {
    for (const childId of message.childIds) {
      const child = byId.get(childId);
      if (!child) {
        findings.push({
          code: "CHILD_RESPONSE_MISSING",
          severity: "warning",
          message: `Response ${message.id} references missing child ${childId}.`,
          conversationId: conversation.id,
          responseId: message.id,
        });
      } else if (child.parentId && child.parentId !== message.id) {
        findings.push({
          code: "GRAPH_PARENT_CONFLICT",
          severity: "error",
          message: `Response ${childId} names parent ${child.parentId}, but ${message.id} also names it as a child.`,
          conversationId: conversation.id,
          responseId: childId,
        });
      }
    }
  }

  for (const message of conversation.messages) {
    const seen = new Set<string>();
    let current = message;
    while (current.parentId) {
      if (seen.has(current.parentId) || current.parentId === message.id) {
        findings.push({
          code: "RESPONSE_GRAPH_CYCLE",
          severity: "error",
          message: `Response graph contains a cycle involving ${message.id}.`,
          conversationId: conversation.id,
          responseId: message.id,
        });
        break;
      }
      seen.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
  }
  return findings;
}

function dedupeFindings(findings: ValidationFinding[]): ValidationFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = [finding.code, finding.severity, finding.conversationId, finding.responseId, finding.assetId, finding.message].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

