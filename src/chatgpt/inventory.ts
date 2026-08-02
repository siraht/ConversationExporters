import type { ArchiveFileSystem } from "../core/filesystem";
import { hashJson, sha256Hex } from "../core/hash";
import { isJsonObject } from "../core/json";
import { safePathSegment } from "../core/paths";
import { prettyJson } from "../core/serialization";
import type {
  ConversationInventory,
  ConversationScope,
  InventoryChain,
  InventoryConversation,
  InventoryPageRecord,
  InventoryProject,
  InventoryProjectFile,
  JsonObject,
  JsonValue,
  ScopeMembership,
  ScopeTermination,
} from "../core/types";
import type { ChatGptTransport, DiscoveredWorkspace } from "./client";
import type { ChatGptOperationParameters } from "./endpoints";

export interface InventorySettings {
  pageSize: number;
  maxPagesPerChain: number;
  maxInventoryBytes: number;
  includeArchived: boolean;
  includeProjects: boolean;
  includeShared: boolean;
}

export interface InventoryProgress {
  scope: ConversationScope;
  chainId: string;
  pageNumber: number;
  uniqueConversations: number;
}

export interface ChatGptInventoryOptions {
  transport: ChatGptTransport;
  filesystem: ArchiveFileSystem;
  workspace: DiscoveredWorkspace;
  settings: InventorySettings;
  now?: () => Date;
  onProgress?: (progress: InventoryProgress) => void;
}

export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  pageSize: 100,
  maxPagesPerChain: 10_000,
  maxInventoryBytes: 2_000_000_000,
  includeArchived: true,
  includeProjects: true,
  includeShared: true,
};

export class ChatGptInventoryEngine {
  private readonly conversations = new Map<string, InventoryConversation>();
  private readonly projects = new Map<string, InventoryProject>();
  private readonly pages: InventoryPageRecord[] = [];
  private readonly chains: InventoryChain[] = [];
  private readonly now: () => Date;
  private aggregateBytes = 0;

  constructor(private readonly options: ChatGptInventoryOptions) {
    this.now = options.now ?? (() => new Date());
    validateSettings(options.settings);
  }

  async run(): Promise<ConversationInventory> {
    const previous = parsePreviousInventory(await this.options.filesystem.readText("inventory.json"), this.options.workspace.workspaceFingerprint);
    await this.captureOffsetChain("main", "main", false);
    if (this.options.settings.includeArchived) await this.captureOffsetChain("archived", "archived", true);
    if (this.options.settings.includeProjects) await this.captureProjects();
    if (this.options.settings.includeShared) await this.captureShared();

    const inventory: ConversationInventory = {
      schemaVersion: 1,
      provider: "chatgpt-web",
      workspaceFingerprint: this.options.workspace.workspaceFingerprint,
      generatedAt: this.now().toISOString(),
      complete: this.chains.every((chain) => chain.complete),
      chains: [...this.chains],
      pages: [...this.pages],
      projects: [...this.projects.values()].sort((left, right) => left.projectId.localeCompare(right.projectId)),
      absentConversations: retainedAbsent(previous, this.conversations),
      conversations: [...this.conversations.values()].sort((left, right) => left.logicalKey.localeCompare(right.logicalKey)),
    };
    if (!inventory.complete) throw new InventoryError("INVENTORY_INCOMPLETE", "Not every inventory chain terminated normally.");
    if (previous) {
      const previousText = prettyJson(previous);
      const previousHash = await sha256Hex(previousText);
      const previousPath = `source/inventory/snapshots/inventory-${previousHash}.json`;
      if (!await this.options.filesystem.exists(previousPath)) await this.options.filesystem.writeTextAtomic(previousPath, previousText);
    }
    await this.options.filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
    await this.options.filesystem.writeTextAtomic("reports/reconciliation.json", prettyJson({
      schemaVersion: 1,
      provider: "chatgpt-web",
      workspaceFingerprint: this.options.workspace.workspaceFingerprint,
      inventoryHash: await hashJson(JSON.parse(JSON.stringify(inventory)) as JsonValue),
      expectedConversationCount: inventory.conversations.length,
      absentRetainedConversationCount: inventory.absentConversations?.length ?? 0,
      pageEvidenceCount: inventory.pages.length,
      aggregateResponseBytes: this.aggregateBytes,
      allChainsComplete: inventory.chains.every((item) => item.complete && item.terminationReason !== null),
      conversationCountsByScope: Object.fromEntries((["main", "archived", "project", "shared"] as const).map((scope) => [
        scope,
        inventory.conversations.filter((conversation) => conversation.memberships.some((membership) => membership.scope === scope)).length,
      ])),
      chains: inventory.chains.map((item) => ({
        chainId: item.chainId,
        scope: item.scope,
        pageCount: item.pageCount,
        itemCount: item.itemCount,
        uniqueConversationCount: item.uniqueConversationCount,
        terminationReason: item.terminationReason,
      })),
    }));
    return inventory;
  }

  private async captureOffsetChain(scope: "main" | "archived", chainId: string, archived: boolean): Promise<void> {
    const seenIds = new Set<string>();
    const seenOrderedHashes = new Set<string>();
    let offset = 0;
    let totalItems = 0;

    for (let pageNumber = 1; pageNumber <= this.options.settings.maxPagesPerChain; pageNumber += 1) {
      const operation = {
        operation: "conversation_page",
        parameters: { offset, limit: this.options.settings.pageSize, archived },
      } as const;
      const response = await this.request(operation);
      const object = requireObject(response.body, `${scope} page`);
      const items = requireObjectArray(object.items, `${scope} page.items`);
      const total = nullableTotal(object.total, `${scope} page.total`);
      const ids = items.map((item, index) => requiredId(item, `${scope} page item ${index}`));
      const duplicateCount = ids.filter((id) => seenIds.has(id)).length;
      const orderedIdHash = await hashIds(ids);
      if (ids.length && seenOrderedHashes.has(orderedIdHash)) {
        throw new InventoryError("INVENTORY_REPEATED_PAGE", `${scope} history repeated an ordered page at offset ${offset}.`);
      }
      if (ids.length) seenOrderedHashes.add(orderedIdHash);
      for (const [index, item] of items.entries()) {
        const id = ids[index]!;
        seenIds.add(id);
        await this.mergeConversation(id, item, { scope });
      }
      totalItems += items.length;
      const nextOffset = offset + items.length;
      let termination: ScopeTermination | null = null;
      if (items.length === 0) {
        if (total === 0 && offset === 0) termination = "recognized_empty_account";
        else if (total === null || offset >= total) termination = "empty_page";
        else throw new InventoryError("INVENTORY_PREMATURE_EMPTY_PAGE", `${scope} history returned an empty page at ${offset} before declared total ${total}.`);
      } else if (total !== null && nextOffset >= total) {
        termination = "declared_total_reached";
      }
      await this.recordPage(scope, chainId, pageNumber, { offset, limit: this.options.settings.pageSize }, null, items.length, response.responseBytes, response.body, orderedIdHash, duplicateCount, termination);
      this.report(scope, chainId, pageNumber);
      if (termination) {
        this.chains.push(chain(chainId, scope, pageNumber, totalItems, seenIds.size, termination));
        return;
      }
      if (nextOffset <= offset) throw new InventoryError("INVENTORY_OFFSET_STALL", `${scope} history offset did not advance.`);
      offset = nextOffset;
    }
    throw new InventoryError("INVENTORY_PAGE_LIMIT", `${scope} history hit the configured page limit before normal termination.`);
  }

  private async captureProjects(): Promise<void> {
    const projects = new Map<string, InventoryProject>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let projectPageCount = 0;
    let projectItemCount = 0;

    for (let pageNumber = 1; pageNumber <= this.options.settings.maxPagesPerChain; pageNumber += 1) {
      projectPageCount = pageNumber;
      const response = await this.request({ operation: "project_page", parameters: { cursor } });
      const object = requireObject(response.body, "project page");
      const items = requireObjectArray(object.items, "project page.items");
      const ids: string[] = [];
      for (const [index, item] of items.entries()) {
        const project = { ...parseProject(item, index), rawHash: await hashJson(item) };
        ids.push(project.projectId);
        projects.set(project.projectId, project);
        this.projects.set(project.projectId, project);
      }
      projectItemCount += items.length;
      const nextCursor = optionalCursor(object.cursor, "project page.cursor");
      if (items.length === 0 && nextCursor !== null) throw new InventoryError("INVENTORY_PREMATURE_EMPTY_PAGE", "Project index returned an empty page with another cursor.");
      const termination = nextCursor === null ? "cursor_exhausted" as const : null;
      await this.recordPage("project", "project-index", pageNumber, { ...(cursor === null ? {} : { cursor }) }, nextCursor, items.length, response.responseBytes, response.body, await hashIds(ids), ids.length - new Set(ids).size, termination);
      this.report("project", "project-index", pageNumber);
      if (nextCursor === null) break;
      if (seenCursors.has(nextCursor) || nextCursor === cursor) throw new InventoryError("INVENTORY_CURSOR_CYCLE", "Project index returned a repeated cursor.");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === this.options.settings.maxPagesPerChain) throw new InventoryError("INVENTORY_PAGE_LIMIT", "Project index hit the configured page limit.");
    }
    this.chains.push(chain("project-index", "project", projectPageCount, projectItemCount, 0, "cursor_exhausted"));
    for (const project of [...projects.values()].sort((left, right) => left.projectId.localeCompare(right.projectId))) {
      await this.captureProjectConversationChain(project);
    }
  }

  private async captureProjectConversationChain(project: InventoryProject): Promise<void> {
    const chainId = `project-${project.projectId}`;
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = "0";
    let totalItems = 0;

    for (let pageNumber = 1; pageNumber <= this.options.settings.maxPagesPerChain; pageNumber += 1) {
      const response = await this.request({
        operation: "project_conversation_page",
        parameters: { projectId: project.projectId, cursor },
      });
      const object = requireObject(response.body, `project ${project.projectId} conversation page`);
      const items = requireObjectArray(object.items, `project ${project.projectId} conversation page.items`);
      const ids = items.map((item, index) => requiredId(item, `project ${project.projectId} item ${index}`));
      const duplicateCount = ids.filter((id) => seenIds.has(id)).length;
      for (const [index, item] of items.entries()) {
        const id = ids[index]!;
        seenIds.add(id);
        await this.mergeConversation(id, item, { scope: "project", projectId: project.projectId, ...(project.name === null ? {} : { projectName: project.name }) });
      }
      totalItems += items.length;
      const nextCursor = optionalCursor(object.cursor, `project ${project.projectId} page.cursor`);
      if (items.length === 0 && nextCursor !== null) throw new InventoryError("INVENTORY_PREMATURE_EMPTY_PAGE", `Project ${project.projectId} returned an empty conversation page with another cursor.`);
      const termination = nextCursor === null ? "cursor_exhausted" as const : null;
      await this.recordPage("project", chainId, pageNumber, { cursor, projectId: project.projectId }, nextCursor, items.length, response.responseBytes, response.body, await hashIds(ids), duplicateCount, termination);
      this.report("project", chainId, pageNumber);
      if (nextCursor === null) {
        this.chains.push({ ...chain(chainId, "project", pageNumber, totalItems, seenIds.size, "cursor_exhausted"), projectId: project.projectId });
        return;
      }
      if (seenCursors.has(nextCursor) || nextCursor === cursor) throw new InventoryError("INVENTORY_CURSOR_CYCLE", `Project ${project.projectId} returned a repeated conversation cursor.`);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new InventoryError("INVENTORY_PAGE_LIMIT", `Project ${project.projectId} hit the configured conversation page limit.`);
  }

  private async captureShared(): Promise<void> {
    const chainId = "shared";
    const seenShareIds = new Set<string>();
    const seenOrderedHashes = new Set<string>();
    let offset = 0;
    let totalItems = 0;

    for (let pageNumber = 1; pageNumber <= this.options.settings.maxPagesPerChain; pageNumber += 1) {
      const response = await this.request({ operation: "shared_page", parameters: { offset, limit: this.options.settings.pageSize } });
      const object = requireObject(response.body, "shared page");
      const items = requireObjectArray(object.items, "shared page.items");
      const total = nullableTotal(object.total, "shared page.total");
      const shareIds = items.map((item, index) => requiredId(item, `shared page item ${index}`));
      const duplicateCount = shareIds.filter((id) => seenShareIds.has(id)).length;
      const orderedIdHash = await hashIds(shareIds);
      if (shareIds.length && seenOrderedHashes.has(orderedIdHash)) throw new InventoryError("INVENTORY_REPEATED_PAGE", `Shared history repeated an ordered page at offset ${offset}.`);
      if (shareIds.length) seenOrderedHashes.add(orderedIdHash);
      for (const [index, item] of items.entries()) {
        const shareId = shareIds[index]!;
        seenShareIds.add(shareId);
        const ownedId = optionalId(item.conversation_id);
        await this.mergeConversation(ownedId ?? `share_${shareId}`, item, { scope: "shared", shareId });
      }
      totalItems += items.length;
      const nextOffset = offset + items.length;
      let termination: ScopeTermination | null = null;
      if (items.length === 0) {
        if (total !== null && offset < total) throw new InventoryError("INVENTORY_PREMATURE_EMPTY_PAGE", `Shared history returned an empty page at ${offset} before declared total ${total}.`);
        termination = total === 0 && offset === 0 ? "recognized_empty_account" : "empty_page";
      }
      else if (total !== null && nextOffset >= total) termination = "declared_total_reached";
      await this.recordPage("shared", chainId, pageNumber, { offset, limit: this.options.settings.pageSize }, null, items.length, response.responseBytes, response.body, orderedIdHash, duplicateCount, termination);
      this.report("shared", chainId, pageNumber);
      if (termination) {
        this.chains.push(chain(chainId, "shared", pageNumber, totalItems, seenShareIds.size, termination));
        return;
      }
      if (nextOffset <= offset) throw new InventoryError("INVENTORY_OFFSET_STALL", "Shared history offset did not advance.");
      offset = nextOffset;
    }
    throw new InventoryError("INVENTORY_PAGE_LIMIT", "Shared history hit the configured page limit before normal termination.");
  }

  private async mergeConversation(conversationId: string, raw: JsonObject, membership: ScopeMembership): Promise<void> {
    const logicalKey = `${this.options.workspace.workspaceFingerprint}/${conversationId}`;
    const listingHash = await hashJson(raw);
    const existing = this.conversations.get(logicalKey);
    if (existing) {
      if (!existing.listingHashes.includes(listingHash)) existing.listingHashes.push(listingHash);
      existing.listingRecords ??= [];
      if (!existing.listingRecords.some((record) => JSON.stringify(record) === JSON.stringify(raw))) existing.listingRecords.push(raw);
      if (!existing.memberships.some((candidate) => membershipKey(candidate) === membershipKey(membership))) existing.memberships.push(membership);
      return;
    }
    this.conversations.set(logicalKey, {
      logicalKey,
      conversationId,
      title: optionalText(raw.title),
      createTime: optionalNumber(raw.create_time),
      updateTime: optionalNumber(raw.update_time),
      memberships: [membership],
      listingHashes: [listingHash],
      listingRecords: [raw],
    });
  }

  private async recordPage(
    scope: ConversationScope,
    chainId: string,
    pageNumber: number,
    request: InventoryPageRecord["request"],
    nextCursor: string | null,
    itemCount: number,
    responseBytes: number,
    body: JsonValue,
    orderedIdHash: string,
    duplicateCount: number,
    terminationReason: ScopeTermination | null,
  ): Promise<void> {
    this.aggregateBytes += responseBytes;
    if (this.aggregateBytes > this.options.settings.maxInventoryBytes) throw new InventoryError("INVENTORY_BYTE_LIMIT", "Inventory exceeded the configured byte safety limit.");
    const rawResponseHash = await hashJson(body);
    const path = `source/inventory/${safePathSegment(scope)}/${safePathSegment(chainId, "chain", 220)}/page-${String(pageNumber).padStart(6, "0")}-${rawResponseHash}.json`;
    await this.options.filesystem.writeTextAtomic(path, prettyJson(body));
    this.pages.push({
      scope,
      chainId,
      pageNumber,
      request,
      nextCursor,
      itemCount,
      responseBytes,
      rawResponseHash,
      orderedIdHash,
      duplicateCount,
      terminationReason,
    });
  }

  private async request(operation: ChatGptOperationParameters) {
    return this.options.transport.request(operation, this.options.workspace.accountId);
  }

  private report(scope: ConversationScope, chainId: string, pageNumber: number): void {
    this.options.onProgress?.({ scope, chainId, pageNumber, uniqueConversations: this.conversations.size });
  }
}

export async function runWorkspaceInventories(options: {
  transport: ChatGptTransport;
  targets: Array<{ workspace: DiscoveredWorkspace; filesystem: ArchiveFileSystem }>;
  settings: InventorySettings;
  now?: () => Date;
  onProgress?: (workspaceFingerprint: string, progress: InventoryProgress) => void;
}): Promise<Map<string, ConversationInventory>> {
  if (options.targets.length === 0) throw new InventoryError("NO_WORKSPACES_SELECTED", "At least one workspace must be selected.");
  const fingerprints = options.targets.map((target) => target.workspace.workspaceFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) throw new InventoryError("DUPLICATE_WORKSPACE", "Each workspace may be inventoried only once per run.");
  const results = new Map<string, ConversationInventory>();
  for (const target of options.targets) {
    if (target.workspace.deactivated) throw new InventoryError("WORKSPACE_DEACTIVATED", "A selected workspace is deactivated.");
    const inventory = await new ChatGptInventoryEngine({
      transport: options.transport,
      filesystem: target.filesystem,
      workspace: target.workspace,
      settings: options.settings,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onProgress === undefined ? {} : {
        onProgress: (progress) => options.onProgress?.(target.workspace.workspaceFingerprint, progress),
      }),
    }).run();
    results.set(target.workspace.workspaceFingerprint, inventory);
  }
  return results;
}

export class InventoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

function validateSettings(settings: InventorySettings): void {
  if (!Number.isInteger(settings.pageSize) || settings.pageSize < 1 || settings.pageSize > 100) throw new InventoryError("INVALID_SETTINGS", "pageSize must be 1-100.");
  if (!Number.isInteger(settings.maxPagesPerChain) || settings.maxPagesPerChain < 1) throw new InventoryError("INVALID_SETTINGS", "maxPagesPerChain must be positive.");
  if (!Number.isFinite(settings.maxInventoryBytes) || settings.maxInventoryBytes < 1) throw new InventoryError("INVALID_SETTINGS", "maxInventoryBytes must be positive.");
}

function chain(chainId: string, scope: ConversationScope, pageCount: number, itemCount: number, uniqueConversationCount: number, terminationReason: ScopeTermination): InventoryChain {
  return { chainId, scope, complete: true, terminationReason, pageCount, itemCount, uniqueConversationCount };
}

function requireObject(value: JsonValue | undefined, name: string): JsonObject {
  if (!isJsonObject(value)) throw new InventoryError("INVALID_INVENTORY_ENVELOPE", `${name} must be an object.`);
  return value;
}

function requireObjectArray(value: JsonValue | undefined, name: string): JsonObject[] {
  if (!Array.isArray(value) || !value.every(isJsonObject)) throw new InventoryError("INVALID_INVENTORY_ENVELOPE", `${name} must be an array of objects.`);
  return value;
}

function requiredId(value: JsonObject, name: string): string {
  const id = optionalId(value.id);
  if (!id) throw new InventoryError("INVENTORY_ID_MISSING", `${name} has no valid id.`);
  return id;
}

function optionalId(value: JsonValue | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : null;
}

function optionalText(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableTotal(value: JsonValue | undefined, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) < 0) throw new InventoryError("INVALID_INVENTORY_ENVELOPE", `${name} must be a non-negative integer or null.`);
  return value as number;
}

function optionalCursor(value: JsonValue | undefined, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,512}$/.test(value)) throw new InventoryError("INVALID_INVENTORY_ENVELOPE", `${name} is invalid.`);
  return value;
}

function parseProject(value: JsonObject, index: number): Omit<InventoryProject, "rawHash"> {
  const first = isJsonObject(value.gizmo) ? value.gizmo : value;
  const project = isJsonObject(first.gizmo) ? first.gizmo : first;
  const projectId = requiredId(project, `project page item ${index}`);
  const display = isJsonObject(project.display) ? project.display : undefined;
  const rawFiles = Array.isArray(first.files) ? first.files : Array.isArray(project.files) ? project.files : [];
  const files = rawFiles.flatMap((candidate, fileIndex): InventoryProjectFile[] => {
    if (!isJsonObject(candidate)) return [];
    const providerId = optionalId(candidate.file_id) ?? optionalId(candidate.id);
    if (providerId === null) return [];
    return [{
      logicalId: `project-${projectId}-file-${providerId}-${fileIndex}`,
      providerId,
      originalName: optionalText(candidate.name) ?? optionalText(candidate.filename),
      mediaType: optionalText(candidate.type) ?? optionalText(candidate.mime_type),
      byteSize: nonNegativeNumber(candidate.size),
      rawDescriptor: candidate,
    }];
  });
  return {
    projectId,
    name: optionalText(display?.name) ?? optionalText(project.name),
    description: optionalText(display?.description) ?? optionalText(project.description),
    instructions: optionalText(project.instructions),
    createTime: optionalNumber(project.created_at) ?? optionalNumber(project.create_time),
    updateTime: optionalNumber(project.updated_at) ?? optionalNumber(project.update_time),
    files,
  };
}

function nonNegativeNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function hashIds(ids: string[]): Promise<string> {
  return sha256Hex(ids.join("\n"));
}

function membershipKey(membership: ScopeMembership): string {
  return `${membership.scope}\0${membership.projectId ?? ""}\0${membership.shareId ?? ""}`;
}

function parsePreviousInventory(value: string | undefined, workspaceFingerprint: string): ConversationInventory | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as ConversationInventory;
    return parsed.schemaVersion === 1
      && parsed.provider === "chatgpt-web"
      && parsed.workspaceFingerprint === workspaceFingerprint
      && parsed.complete
      && Array.isArray(parsed.conversations)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function retainedAbsent(previous: ConversationInventory | undefined, current: Map<string, InventoryConversation>): InventoryConversation[] {
  if (!previous) return [];
  const candidates = [...previous.conversations, ...(previous.absentConversations ?? [])];
  const absent = new Map<string, InventoryConversation>();
  for (const conversation of candidates) {
    if (!current.has(conversation.logicalKey)) absent.set(conversation.logicalKey, conversation);
  }
  return [...absent.values()].sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
}
