import { homedir } from "node:os";
import { join } from "node:path";
import type { SyncConfig } from "./types.js";

export function configFromEnvironment(environment = process.env): SyncConfig {
  const home = environment.HOME || homedir();
  return {
    archiveRoot: environment.ASM_ARCHIVE_ROOT || join(home, ".local", "share", "agent-session-archive"),
    asmBinary: environment.ASM_BINARY || "asm",
    dataRoot: environment.CONVERSATION_SYNC_ROOT || join(home, "ConversationImports"),
    accountLabel: environment.CONVERSATION_ACCOUNT_LABEL || "personal",
    destination: environment.CONVERSATION_SYNC_DESTINATION || "flywheel",
    rcloneBinary: environment.RCLONE_BINARY || "rclone",
    driveRemote: environment.CONVERSATION_DRIVE_REMOTE || "conversation-drive",
    drivePath: environment.CONVERSATION_AI_STUDIO_PATH || "Google AI Studio",
  };
}
