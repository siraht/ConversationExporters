import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { syncOnce } from "../src/sync.js";
import type { SyncConfig } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("syncOnce", () => {
  it("imports each changed source once, records unsupported files, and emits aggregates only", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.dataRoot, "incoming", "claude.zip"), "revision-one");
    await writeFile(join(fixture.dataRoot, "incoming", "metadata.zip"), "unsupported");

    const first = await syncOnce(fixture.config, { push: false });
    expect(first).toMatchObject({ scanned: 2, imported: 1, unsupported: 1, newVersions: 3 });

    const second = await syncOnce(fixture.config, { push: false });
    expect(second).toMatchObject({ scanned: 2, imported: 0, unchanged: 2, newVersions: 0 });

    await writeFile(join(fixture.dataRoot, "incoming", "claude.zip"), "revision-two");
    const third = await syncOnce(fixture.config, { push: false });
    expect(third).toMatchObject({ scanned: 2, imported: 1, unchanged: 1, newVersions: 3 });

    const calls = (await readFile(fixture.calls, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(first)).not.toContain("private-conversation-id");
  });

  it("pushes through the archive protocol when requested", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.dataRoot, "incoming", "claude.zip"), "revision-one");
    const result = await syncOnce(fixture.config, { push: true });
    expect(result).toMatchObject({ pushed: true, pushObjects: 4, pushBytes: 2048 });
  });
});

async function setup(): Promise<{
  dataRoot: string;
  config: SyncConfig;
  calls: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "conversation-sync-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const incoming = join(dataRoot, "incoming");
  const binary = join(root, "fake-asm");
  const calls = join(root, "calls.txt");
  await mkdir(incoming, { recursive: true });
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in\n  *metadata.zip*) printf '%s\\n' '{"ok":false,"error":{"code":"adapter_not_detected"}}' >&2; exit 2 ;;\n  *' push '*) printf '%s\\n' '{"ok":true,"result":{"objects":4,"bytes":2048}}' ;;\n  *) printf '%s\\n' '{"ok":true,"result":{"provider":"claude-web","candidates":3,"new_versions":3,"conversation_ids":["private-conversation-id"]}}' ;;\nesac\n`);
  await chmod(binary, 0o700);
  return {
    dataRoot,
    calls,
    config: {
      archiveRoot: join(root, "archive"),
      asmBinary: binary,
      dataRoot,
      accountLabel: "personal",
      destination: "flywheel",
    },
  };
}
