import { ChatGptClient, type DiscoveredWorkspace } from "../chatgpt/client";
import { CHATGPT_PROVIDER } from "../chatgpt/provider";
import { DirectoryArchiveFileSystem, type ArchiveFileSystem } from "../core/filesystem";
import { NativeArchiveFileSystem } from "@conversation-exporters/shared/native-filesystem";
import { DEFAULT_INVENTORY_SETTINGS, runWorkspaceInventories } from "../chatgpt/inventory";
import { ChatGptCaptureEngine } from "../chatgpt/capture-engine";
import { auditArchive, type ArchiveAuditReport } from "../chatgpt/audit";
import { ControlledTransport } from "../core/request-control";
import { ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle } from "./handle-store";
import { BridgeResponseError, RuntimeApiTransport, type FindTabResult } from "./protocol";
import { automaticInterval, dashboardErrorMessage, requiredElement as element, setDashboardStatus, strictInteger } from "@conversation-exporters/shared/dashboard";

const chooseButton = element<HTMLButtonElement>("choose-directory");
const openButton = element<HTMLButtonElement>("open-chatgpt");
const findButton = element<HTMLButtonElement>("find-chatgpt");
const preflightButton = element<HTMLButtonElement>("preflight-workspace");
const inventoryButton = element<HTMLButtonElement>("run-inventory");
const captureButton = element<HTMLButtonElement>("run-capture");
const confirmInventoryButton = element<HTMLButtonElement>("confirm-inventory");
const revalidateButton = element<HTMLButtonElement>("revalidate");
const pauseButton = element<HTMLButtonElement>("pause-run");
const resumeButton = element<HTMLButtonElement>("resume-run");
const cancelButton = element<HTMLButtonElement>("cancel-run");
const workspaceSelect = element<HTMLSelectElement>("workspace-select");
const archivedScope = element<HTMLInputElement>("scope-archived");
const projectScope = element<HTMLInputElement>("scope-projects");
const sharedScope = element<HTMLInputElement>("scope-shared");
const accountScope = element<HTMLInputElement>("scope-account");
const assetScope = element<HTMLInputElement>("scope-assets");
const requestDelay = element<HTMLInputElement>("request-delay");
const requestConcurrency = element<HTMLInputElement>("request-concurrency");
const batchSize = element<HTMLInputElement>("batch-size");
const inventorySummary = element<HTMLElement>("inventory-summary");
const directoryLabel = element<HTMLElement>("directory-label");
const status = element<HTMLElement>("status");
const log = element<HTMLElement>("log");

let directoryHandle: FileSystemDirectoryHandle | undefined;
let client: ChatGptClient | undefined;
let runtimeTransport: RuntimeApiTransport | undefined;
let workspaces: DiscoveredWorkspace[] = [];
let verifiedWorkspaces: DiscoveredWorkspace[] = [];
let inventoryConfirmed = false;
let activeController: ControlledTransport | undefined;
const autoInterval = automaticInterval(location.search);
let automaticRunning = false;
declare const __NATIVE_ARCHIVE__: boolean;
const nativeFilesystems = new Map<string, NativeArchiveFileSystem>();

chooseButton.addEventListener("click", () => void chooseDirectory());
openButton.addEventListener("click", () => void chrome.tabs.create({ url: `${CHATGPT_PROVIDER.primaryOrigin}/` }));
findButton.addEventListener("click", () => void findTabAndWorkspaces());
preflightButton.addEventListener("click", () => void preflightWorkspace());
inventoryButton.addEventListener("click", () => void runInventory());
captureButton.addEventListener("click", () => void runCapture());
confirmInventoryButton.addEventListener("click", confirmInventory);
revalidateButton.addEventListener("click", () => void revalidateArchives());
pauseButton.addEventListener("click", () => activeController?.pause());
resumeButton.addEventListener("click", () => activeController?.resume());
cancelButton.addEventListener("click", () => activeController?.cancel());
[archivedScope, projectScope, sharedScope].forEach((scope) => scope.addEventListener("change", () => {
  inventoryConfirmed = false;
  confirmInventoryButton.disabled = true;
  captureButton.disabled = true;
  revalidateButton.disabled = true;
  inventorySummary.textContent = "Scope selection changed. Build and confirm a fresh inventory before capture.";
}));
workspaceSelect.addEventListener("change", () => {
  verifiedWorkspaces = [];
  chooseButton.disabled = true;
  inventoryButton.disabled = true;
  captureButton.disabled = true;
  confirmInventoryButton.disabled = true;
  revalidateButton.disabled = true;
  inventoryConfirmed = false;
  preflightButton.disabled = workspaceSelect.selectedOptions.length === 0;
  directoryLabel.textContent = workspaceSelect.selectedOptions.length ? "Verify selected workspaces first" : "Select one or more workspaces first";
});
void initialize();

async function initialize(): Promise<void> {
  if (__NATIVE_ARCHIVE__) {
    try {
      const filesystem = workspaceFilesystem("probe");
      await filesystem.ready();
      directoryLabel.textContent = "Private local ChatGPT archive (native host)";
    } catch (error) {
      showError(error);
      return;
    }
  } else {
    await restoreDirectory();
  }
  if (autoInterval !== undefined) {
    setStatus("Automatic sync is enabled for this dashboard.", "ready");
    window.setTimeout(() => void automaticCycle(), 1_000);
  }
}

async function automaticCycle(): Promise<void> {
  if (automaticRunning) return;
  automaticRunning = true;
  try {
    await findTabAndWorkspaces();
    if (status.dataset.state === "error") return;
    for (const item of workspaceSelect.options) item.selected = Boolean(item.value);
    await preflightWorkspace();
    if (status.dataset.state === "error") return;
    if (!__NATIVE_ARCHIVE__ && (!directoryHandle || !await ensureDirectoryPermission(directoryHandle, false))) {
      setStatus("Automatic sync needs a one-time parent-directory selection in this browser profile.", "error");
      return;
    }
    if (__NATIVE_ARCHIVE__) enableNativeDirectory();
    else enableSelectedDirectory(directoryHandle!);
    await runInventory();
    if (status.dataset.state === "error" || confirmInventoryButton.disabled) return;
    confirmInventory();
    await runCapture();
  } finally {
    automaticRunning = false;
    if (autoInterval !== undefined) window.setTimeout(() => void automaticCycle(), autoInterval);
  }
}

async function restoreDirectory(): Promise<void> {
  directoryHandle = await loadDirectoryHandle();
  if (directoryHandle) {
    const granted = await ensureDirectoryPermission(directoryHandle, false);
    directoryLabel.textContent = granted ? `${directoryHandle.name} (permission retained)` : `${directoryHandle.name} (permission required)`;
  }
}

async function chooseDirectory(): Promise<void> {
  if (verifiedWorkspaces.length === 0) {
    setStatus("Verify one or more workspaces before choosing their parent archive directory.", "error");
    return;
  }
  if (__NATIVE_ARCHIVE__) {
    enableNativeDirectory();
    return;
  }
  try {
    if (directoryHandle && await ensureDirectoryPermission(directoryHandle, true)) {
      enableSelectedDirectory(directoryHandle);
      return;
    }
    const selectedHandle = await window.showDirectoryPicker({ id: "chatgpt-exporter-parent", mode: "readwrite" });
    directoryHandle = selectedHandle;
    await saveDirectoryHandle(selectedHandle);
    enableSelectedDirectory(selectedHandle);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) showError(error);
  }
}

function enableNativeDirectory(): void {
  directoryLabel.textContent = "Private local ChatGPT archive (native host)";
  inventoryButton.disabled = false;
  captureButton.disabled = true;
  confirmInventoryButton.disabled = true;
  revalidateButton.disabled = true;
  inventoryConfirmed = false;
  setStatus(`${verifiedWorkspaces.length} workspace${verifiedWorkspaces.length === 1 ? " is" : "s are"} ready for isolated native archives.`, "ready");
}

function enableSelectedDirectory(handle: FileSystemDirectoryHandle): void {
  directoryLabel.textContent = handle.name;
  inventoryButton.disabled = false;
  captureButton.disabled = true;
  confirmInventoryButton.disabled = true;
  revalidateButton.disabled = true;
  inventoryConfirmed = false;
  setStatus(`${verifiedWorkspaces.length} workspace${verifiedWorkspaces.length === 1 ? " is" : "s are"} ready for isolated inventory directories.`, "ready");
}

async function findTabAndWorkspaces(): Promise<void> {
  setBusy(findButton, true);
  resetWorkspaceSelection();
  setStatus("Checking the signed-in ChatGPT session and accessible workspaces…", "busy");
  try {
    const tab = await chrome.runtime.sendMessage<{ type: "CHATGPT_EXPORTER_FIND_TAB" }, FindTabResult>({ type: "CHATGPT_EXPORTER_FIND_TAB" });
    if (!tab.ok || tab.tabId === undefined) throw new Error(tab.error ?? "No ChatGPT tab was found.");
    runtimeTransport = new RuntimeApiTransport(tab.tabId);
    client = new ChatGptClient(runtimeTransport);
    workspaces = (await client.discoverWorkspaces()).filter((workspace) => !workspace.deactivated);
    if (workspaces.length === 0) throw new Error("ChatGPT returned no active accessible workspaces.");
    renderWorkspaces(workspaces);
    setStatus(`Found ${workspaces.length} accessible workspace${workspaces.length === 1 ? "" : "s"}. Select one explicitly.`, "ready");
    log.textContent = "Only sanitized workspace labels are shown. Account identifiers will be hashed before any directory or report name is written.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(findButton, false);
  }
}

async function preflightWorkspace(): Promise<void> {
  const selectedFingerprints = new Set([...workspaceSelect.selectedOptions].map((item) => item.value));
  const selected = workspaces.filter((candidate) => selectedFingerprints.has(candidate.workspaceFingerprint));
  if (!client || selected.length === 0) {
    setStatus("Choose one or more accessible workspaces first.", "error");
    return;
  }
  setBusy(preflightButton, true);
  setStatus("Verifying session, workspace access, and conversation listing…", "busy");
  try {
    const verified: DiscoveredWorkspace[] = [];
    let emptyCount = 0;
    for (const workspace of selected) {
      const result = await client.preflight(workspace);
      verified.push(result.workspace);
      if (result.recognizedEmptyAccount) emptyCount += 1;
    }
    verifiedWorkspaces = verified;
    chooseButton.disabled = false;
    captureButton.disabled = true;
    const retainedDirectory = __NATIVE_ARCHIVE__ || directoryHandle && await ensureDirectoryPermission(directoryHandle, false);
    if (retainedDirectory) {
      inventoryButton.disabled = false;
      directoryLabel.textContent = __NATIVE_ARCHIVE__ ? "Private local ChatGPT archive (native host)" : `${directoryHandle!.name} (permission retained)`;
      setStatus(`Verified ${verified.length} selected workspace${verified.length === 1 ? "" : "s"}${emptyCount ? ` (${emptyCount} empty)` : ""}. The retained archive directory is ready.`, "ready");
    } else {
      inventoryButton.disabled = true;
      directoryLabel.textContent = "No directory selected for this workspace";
      setStatus(`Verified ${verified.length} selected workspace${verified.length === 1 ? "" : "s"}${emptyCount ? ` (${emptyCount} empty)` : ""}. Choose their parent archive directory.`, "ready");
    }
    log.textContent = `Preflight passed for ${verified.length} workspace fingerprint${verified.length === 1 ? "" : "s"}. Each archive will use ChatGPTExport-<fingerprint>; no raw account identifier is written.`;
  } catch (error) {
    verifiedWorkspaces = [];
    chooseButton.disabled = true;
    inventoryButton.disabled = true;
    captureButton.disabled = true;
    if (error instanceof BridgeResponseError && error.code === "AUTHENTICATION_REQUIRED") {
      setStatus("ChatGPT sign-in expired. Sign in or refresh the ChatGPT tab, then find it again.", "error");
    } else if (error instanceof BridgeResponseError && error.code === "RATE_LIMITED") {
      const wait = error.retryAfterMs === undefined ? "the server's cooldown" : `${Math.ceil(error.retryAfterMs / 1_000)} seconds`;
      setStatus(`ChatGPT rate-limited preflight. Wait ${wait}, then verify again.`, "error");
    } else {
      showError(error);
    }
  } finally {
    setBusy(preflightButton, false);
  }
}

function renderWorkspaces(values: DiscoveredWorkspace[]): void {
  workspaceSelect.replaceChildren(option("", "Choose a workspace…"));
  for (const workspace of values) {
    workspaceSelect.append(option(workspace.workspaceFingerprint, `${workspace.label} · ${workspace.kind}`));
  }
  workspaceSelect.disabled = false;
  preflightButton.disabled = true;
}

function resetWorkspaceSelection(): void {
  workspaces = [];
  client = undefined;
  runtimeTransport = undefined;
  verifiedWorkspaces = [];
  workspaceSelect.replaceChildren(option("", "Checking ChatGPT…"));
  workspaceSelect.disabled = true;
  preflightButton.disabled = true;
  chooseButton.disabled = true;
  inventoryButton.disabled = true;
  captureButton.disabled = true;
  confirmInventoryButton.disabled = true;
  revalidateButton.disabled = true;
  inventoryConfirmed = false;
  directoryLabel.textContent = "Verify a workspace first";
}

async function runInventory(): Promise<void> {
  if (verifiedWorkspaces.length === 0 || (!directoryHandle && !__NATIVE_ARCHIVE__) || !runtimeTransport) {
    setStatus("Verify selected workspaces and choose their parent archive directory first.", "error");
    return;
  }
  if (!__NATIVE_ARCHIVE__ && !await ensureDirectoryPermission(directoryHandle!, true)) {
    setStatus("Write permission for the archive directory is required.", "error");
    return;
  }
  setBusy(inventoryButton, true);
  inventoryConfirmed = false;
  confirmInventoryButton.disabled = true;
  captureButton.disabled = true;
  revalidateButton.disabled = true;
  chooseButton.disabled = true;
  workspaceSelect.disabled = true;
  preflightButton.disabled = true;
  setStatus("Building complete inventory; conversation bodies are not being downloaded yet…", "busy");
  try {
    const controlled = createControlledTransport(runtimeTransport);
    activeController = controlled;
    setRunControls(true);
    const targets = await Promise.all(verifiedWorkspaces.map(async (workspace) => ({
      workspace,
      filesystem: await workspaceArchive(workspace),
    })));
    const inventories = await runWorkspaceInventories({
      transport: controlled,
      targets,
      settings: {
        ...DEFAULT_INVENTORY_SETTINGS,
        includeArchived: archivedScope.checked,
        includeProjects: projectScope.checked,
        includeShared: sharedScope.checked,
      },
      onProgress: (workspaceFingerprint, progress) => {
        setStatus(`Inventorying ${workspaceFingerprint.slice(0, 8)}… / ${progress.chainId}, page ${progress.pageNumber}; ${progress.uniqueConversations} unique conversations found…`, "busy");
      },
    });
    const conversationCount = [...inventories.values()].reduce((sum, inventory) => sum + inventory.conversations.length, 0);
    const pageCount = [...inventories.values()].reduce((sum, inventory) => sum + inventory.pages.length, 0);
    const projectCount = [...inventories.values()].reduce((sum, inventory) => sum + (inventory.projects?.length ?? 0), 0);
    const responseBytes = [...inventories.values()].flatMap((inventory) => inventory.pages).reduce((sum, page) => sum + page.responseBytes, 0);
    setStatus(`Inventory complete: ${conversationCount} workspace-scoped conversations across ${inventories.size} isolated archives.`, "ready");
    inventorySummary.textContent = `${conversationCount} conversations, ${projectCount} projects, ${pageCount} raw listing pages, ${formatBytes(responseBytes)} of listing responses. Review these aggregate counts, then confirm.`;
    log.textContent = "Every enabled inventory chain terminated normally and its reconciliation report was published. Confirmation is required before body capture.";
    confirmInventoryButton.disabled = false;
    revalidateButton.disabled = false;
  } catch (error) {
    showError(error);
  } finally {
    activeController = undefined;
    setRunControls(false);
    inventoryButton.disabled = false;
    chooseButton.disabled = false;
    workspaceSelect.disabled = false;
    preflightButton.disabled = false;
  }
}

async function runCapture(): Promise<void> {
  if (verifiedWorkspaces.length === 0 || (!directoryHandle && !__NATIVE_ARCHIVE__) || !runtimeTransport || !inventoryConfirmed) {
    setStatus("Complete workspace preflight, destination selection, and inventory first.", "error");
    return;
  }
  if (!__NATIVE_ARCHIVE__ && !await ensureDirectoryPermission(directoryHandle!, true)) {
    setStatus("Write permission for the archive directory is required.", "error");
    return;
  }
  setBusy(captureButton, true);
  inventoryButton.disabled = true;
  chooseButton.disabled = true;
  workspaceSelect.disabled = true;
  preflightButton.disabled = true;
  let captured = 0;
  let rebuilt = 0;
  let skipped = 0;
  let failures = 0;
  let partialAssets = 0;
  const audits: ArchiveAuditReport[] = [];
  try {
    const controlled = createControlledTransport(runtimeTransport);
    activeController = controlled;
    setRunControls(true);
    for (const workspace of verifiedWorkspaces) {
      const filesystem = await workspaceArchive(workspace);
      const runId = `capture-${Date.now()}-${crypto.randomUUID()}`;
      const result = await new ChatGptCaptureEngine({
        transport: controlled,
        filesystem,
        workspace,
        runId,
        batchSize: integerValue(batchSize, 1, 10),
        includeAssets: assetScope.checked,
        includeAccountArtifacts: accountScope.checked,
        onProgress: (progress) => {
          setStatus(`Capturing ${workspace.workspaceFingerprint.slice(0, 8)}…: ${progress.completed}/${progress.total} complete (${progress.phase})…`, "busy");
        },
      }).run();
      captured += result.capturedCount;
      rebuilt += result.rebuiltCount;
      skipped += result.skippedCount;
      failures += result.failedCount;
      partialAssets += result.partialAssetCount + result.partialProjectAssetCount;
      audits.push(await auditArchive({ filesystem, extensionVersion: chrome.runtime.getManifest().version }));
    }
    const terminal = combineAuditState(audits);
    setStatus(`Capture ${terminal}: ${captured} fetched, ${rebuilt} rebuilt, ${skipped} unchanged, ${failures} failed, ${partialAssets} partial asset scopes.`, terminal === "complete" ? "complete" : terminal === "conversations complete / assets partial" ? "partial" : "error");
    log.textContent = "Independent set/hash/graph/asset validation was written to reports/validation.md and reports/validation.json. Run Revalidate only after moving or inspecting the archive; rerun capture to retry incomplete records.";
    revalidateButton.disabled = false;
  } catch (error) {
    showError(error);
  } finally {
    activeController = undefined;
    setRunControls(false);
    captureButton.disabled = false;
    inventoryButton.disabled = false;
    chooseButton.disabled = false;
    workspaceSelect.disabled = false;
    preflightButton.disabled = false;
  }
}

function confirmInventory(): void {
  inventoryConfirmed = true;
  captureButton.disabled = false;
  confirmInventoryButton.disabled = true;
  setStatus("Inventory confirmed. Capture can start or resume from existing completion markers.", "ready");
}

async function revalidateArchives(): Promise<void> {
  if (verifiedWorkspaces.length === 0 || (!directoryHandle && !__NATIVE_ARCHIVE__)) {
    setStatus("Verify the workspaces and restore their archive-directory permission first.", "error");
    return;
  }
  setBusy(revalidateButton, true);
  try {
    const reports: ArchiveAuditReport[] = [];
    for (const workspace of verifiedWorkspaces) {
      reports.push(await auditArchive({ filesystem: await workspaceArchive(workspace), extensionVersion: chrome.runtime.getManifest().version }));
    }
    const terminal = combineAuditState(reports);
    const conversations = reports.reduce((sum, report) => sum + report.completeConversationCount, 0);
    const bytes = reports.reduce((sum, report) => sum + report.archiveBytes, 0);
    setStatus(`Revalidation ${terminal}: ${conversations} complete conversations and ${formatBytes(bytes)} audited.`, terminal === "complete" ? "complete" : terminal.includes("partial") ? "partial" : "error");
    log.textContent = "No provider requests were made. Current validation reports and import indexes were rebuilt from local archive bytes.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(revalidateButton, false);
  }
}

async function workspaceArchive(workspace: DiscoveredWorkspace): Promise<ArchiveFileSystem> {
  if (__NATIVE_ARCHIVE__) return workspaceFilesystem(workspace.workspaceFingerprint);
  if (!directoryHandle) throw new Error("Archive directory is unavailable");
  return new DirectoryArchiveFileSystem(await directoryHandle.getDirectoryHandle(`ChatGPTExport-${workspace.workspaceFingerprint}`, { create: true }));
}

function workspaceFilesystem(fingerprint: string): NativeArchiveFileSystem {
  let filesystem = nativeFilesystems.get(fingerprint);
  if (!filesystem) {
    filesystem = new NativeArchiveFileSystem("chatgpt-web", `ChatGPTExport-${fingerprint}`);
    nativeFilesystems.set(fingerprint, filesystem);
  }
  return filesystem;
}

function createControlledTransport(transport: RuntimeApiTransport): ControlledTransport {
  return new ControlledTransport(transport, {
    delayMs: integerValue(requestDelay, 0, 60_000),
    maxConcurrency: integerValue(requestConcurrency, 1, 8),
    onState: (state) => {
      if (state === "paused") setStatus("Paused. The active request may finish; no next request will start until Resume.", "paused");
      pauseButton.disabled = state !== "running";
      resumeButton.disabled = state !== "paused";
    },
  });
}

function setRunControls(running: boolean): void {
  pauseButton.disabled = !running;
  resumeButton.disabled = true;
  cancelButton.disabled = !running;
  requestDelay.disabled = running;
  requestConcurrency.disabled = running;
  batchSize.disabled = running;
}

function integerValue(input: HTMLInputElement, minimum: number, maximum: number): number {
  return strictInteger(input, minimum, maximum);
}

function combineAuditState(reports: ArchiveAuditReport[]): "complete" | "conversations complete / assets partial" | "incomplete" {
  if (reports.some((report) => report.terminalState === "incomplete")) return "incomplete";
  if (reports.some((report) => report.terminalState === "conversations_complete_assets_partial")) return "conversations complete / assets partial";
  return "complete";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
}

function option(value: string, text: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = text;
  return item;
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function setStatus(message: string, state: string): void {
  setDashboardStatus(status, message, state);
}

function showError(error: unknown): void {
  if (error instanceof BridgeResponseError && error.code === "AUTHENTICATION_REQUIRED") {
    setStatus("Authentication required. Sign in or refresh the normal ChatGPT tab, then find and verify it again; completed local work is preserved.", "error");
    return;
  }
  setStatus(dashboardErrorMessage(error), "error");
}
