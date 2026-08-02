import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const providers = [
  {
    workspace: "grok-exporter",
    archive: "packages/grok-exporter/dist/releases/GrokExporter-0.1.0.zip",
    manifest: "packages/grok-exporter/public/manifest.json",
    name: "GrokExporter",
    version: "0.1.0",
    hosts: [
      "https://grok.com/*",
      "https://assets.grok.com/*",
      "https://imagine-public.x.ai/*",
      "https://pbs.twimg.com/*",
      "https://video.twimg.com/*",
    ],
  },
  {
    workspace: "chatgpt-exporter",
    archive: "packages/chatgpt-exporter/dist/releases/ChatGPTExporter-0.1.6.zip",
    manifest: "packages/chatgpt-exporter/public/manifest.json",
    name: "ChatGPTExporter",
    version: "0.1.6",
    hosts: ["https://chatgpt.com/*"],
  },
];

for (const provider of providers) {
  const manifest = JSON.parse(await readFile(path.join(root, provider.manifest), "utf8"));
  assertEqual(manifest.name, provider.name, `${provider.workspace} manifest name`);
  assertEqual(manifest.version, provider.version, `${provider.workspace} manifest version`);
  assertEqual(JSON.stringify(manifest.host_permissions), JSON.stringify(provider.hosts), `${provider.workspace} host permissions`);

  packageWorkspace(provider.workspace);
  const first = await sha256(path.join(root, provider.archive));
  packageWorkspace(provider.workspace);
  const second = await sha256(path.join(root, provider.archive));
  assertEqual(second, first, `${provider.workspace} reproducible package`);
  console.log(`${provider.name} ${provider.version}: manifest boundary and reproducible ZIP verified`);
}

function packageWorkspace(workspace) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--workspace", workspace, "run", "package"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
}

async function sha256(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} changed`);
}
