import { CaptureEngine } from "../core/capture-engine";
import { BrowserAssetFetcher } from "./asset-fetcher";
import { RunControl } from "../core/control";
import { DirectoryArchiveFileSystem, type ArchiveFileSystem } from "../core/filesystem";
import { NativeArchiveFileSystem } from "@conversation-exporters/shared/native-filesystem";
import { DEFAULT_CAPTURE_SETTINGS, type CaptureSettings, type ProgressEvent } from "../core/types";
import { GrokClient } from "../grok/client";
import { GROK_PROVIDER } from "../grok/provider";
import { ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle } from "./handle-store";
import type { FindTabResult } from "./protocol";
import { RuntimeApiTransport } from "./protocol";
import { automaticInterval, boundedInteger, dashboardErrorMessage, requiredElement as element, setDashboardStatus } from "@conversation-exporters/shared/dashboard";

const chooseButton = element<HTMLButtonElement>("choose-directory");
const openGrokButton = element<HTMLButtonElement>("open-grok");
const startButton = element<HTMLButtonElement>("start-export");
const pauseButton = element<HTMLButtonElement>("pause-export");
const cancelButton = element<HTMLButtonElement>("cancel-export");
const directoryLabel = element<HTMLElement>("directory-label");
const status = element<HTMLElement>("status");
const progress = element<HTMLProgressElement>("progress");
const log = element<HTMLElement>("log");
let directoryHandle: FileSystemDirectoryHandle | undefined;
let runControl: RunControl | undefined;
let running = false;
const autoInterval = automaticInterval(location.search);
declare const __NATIVE_ARCHIVE__: boolean;
const nativeFilesystem = __NATIVE_ARCHIVE__ ? new NativeArchiveFileSystem("grok-web") : undefined;

chooseButton.addEventListener("click", () => void chooseDirectory());
openGrokButton.addEventListener("click", () => void chrome.tabs.create({ url: `${GROK_PROVIDER.primaryOrigin}/` }));
startButton.addEventListener("click", () => void startExport());
pauseButton.addEventListener("click", togglePause);
cancelButton.addEventListener("click", () => runControl?.cancel());

void initialize();

async function initialize(): Promise<void> {
  if (nativeFilesystem) {
    try {
      await nativeFilesystem.ready();
      directoryLabel.textContent = "Private local Grok archive (native host)";
      chooseButton.hidden = true;
      startButton.disabled = false;
    } catch (error) {
      showError(error);
      return;
    }
  } else {
    await restoreDirectory();
  }
  if (autoInterval !== undefined) {
    setStatus("Automatic sync is enabled for this dashboard.", "ready");
    window.setTimeout(() => void automaticRun(), 1_000);
  }
}

async function automaticRun(): Promise<void> {
  try {
    if (!nativeFilesystem && (!directoryHandle || !await ensureDirectoryPermission(directoryHandle, false))) {
      setStatus("Automatic sync needs a one-time archive-directory selection in this browser profile.", "error");
      return;
    }
    await startExport();
  } finally {
    if (autoInterval !== undefined) window.setTimeout(() => void automaticRun(), autoInterval);
  }
}

async function restoreDirectory(): Promise<void> {
  directoryHandle = await loadDirectoryHandle();
  if (directoryHandle && await ensureDirectoryPermission(directoryHandle, false)) {
    directoryLabel.textContent = directoryHandle.name;
    startButton.disabled = false;
  } else if (directoryHandle) {
    directoryLabel.textContent = `${directoryHandle.name} (permission required)`;
    startButton.disabled = false;
  }
}

async function chooseDirectory(): Promise<void> {
  try {
    const selectedHandle = await window.showDirectoryPicker({ id: "grok-exporter-archive", mode: "readwrite" });
    directoryHandle = selectedHandle;
    await saveDirectoryHandle(selectedHandle);
    directoryLabel.textContent = selectedHandle.name;
    startButton.disabled = false;
    setStatus("Archive directory ready.", "ready");
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) showError(error);
  }
}

async function startExport(): Promise<void> {
  if (running || (!directoryHandle && !nativeFilesystem)) return;
  if (!nativeFilesystem && !await ensureDirectoryPermission(directoryHandle!, true)) {
    setStatus("Write permission was not granted.", "error");
    return;
  }
  const tab = await chrome.runtime.sendMessage<{ type: "GROK_EXPORTER_FIND_TAB" }, FindTabResult>({ type: "GROK_EXPORTER_FIND_TAB" });
  if (!tab.ok || tab.tabId === undefined) {
    setStatus(tab.error ?? "No authenticated Grok tab was found.", "error");
    return;
  }

  running = true;
  runControl = new RunControl();
  setRunningUi(true);
  log.textContent = "";
  progress.removeAttribute("value");
  try {
    const settings = readSettings();
    const client = new GrokClient({
      transport: new RuntimeApiTransport(tab.tabId),
      settings,
      cancellation: runControl,
      onProgress: showProgress,
    });
    const engine = new CaptureEngine({
      client,
      filesystem: archiveFilesystem(),
      cancellation: runControl,
      onProgress: showProgress,
      ...(settings.includeAssets ? { assetFetcher: new BrowserAssetFetcher() } : {}),
    });
    const summary = await engine.run();
    progress.value = 1;
    progress.max = 1;
    setStatus(
      summary.complete
        ? `Complete: ${summary.completeCount} of ${summary.inventoryCount} conversations archived; ${summary.assetFailureCount} asset issues.`
        : `Incomplete: ${summary.failedCount} conversations still failed. Review reports/validation.md.`,
      summary.complete ? "complete" : "error",
    );
  } catch (error) {
    showError(error);
  } finally {
    running = false;
    runControl = undefined;
    setRunningUi(false);
  }
}

function archiveFilesystem(): ArchiveFileSystem {
  if (nativeFilesystem) return nativeFilesystem;
  if (!directoryHandle) throw new Error("Archive directory is unavailable");
  return new DirectoryArchiveFileSystem(directoryHandle);
}

function togglePause(): void {
  if (!runControl) return;
  if (runControl.paused) {
    runControl.resume();
    pauseButton.textContent = "Pause";
    setStatus("Export resumed.", "running");
  } else {
    runControl.pause();
    pauseButton.textContent = "Resume";
    setStatus("Export will pause before the next request.", "paused");
  }
}

function readSettings(): CaptureSettings {
  return {
    ...DEFAULT_CAPTURE_SETTINGS,
    requestDelayMs: numberInput("request-delay", 100, 10_000),
    responseBatchSize: numberInput("batch-size", 1, 100),
    includeAssets: element<HTMLInputElement>("include-assets").checked,
    includeWorkspaces: element<HTMLInputElement>("include-workspaces").checked,
  };
}

function showProgress(event: ProgressEvent): void {
  if (event.total !== undefined && event.completed !== undefined) {
    progress.max = event.total;
    progress.value = event.completed;
  } else {
    progress.removeAttribute("value");
  }
  setStatus(event.message, "running");
  const line = document.createElement("div");
  line.textContent = event.message;
  log.prepend(line);
  while (log.children.length > 80) log.lastElementChild?.remove();
}

function setRunningUi(value: boolean): void {
  chooseButton.disabled = value;
  startButton.disabled = value || !directoryHandle;
  pauseButton.disabled = !value;
  cancelButton.disabled = !value;
  if (!value) pauseButton.textContent = "Pause";
}

function setStatus(message: string, state: string): void {
  setDashboardStatus(status, message, state);
}

function showError(error: unknown): void {
  setStatus(dashboardErrorMessage(error), "error");
}

function numberInput(id: string, minimum: number, maximum: number): number {
  return boundedInteger(element<HTMLInputElement>(id), minimum, maximum);
}
