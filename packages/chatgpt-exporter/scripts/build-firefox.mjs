import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const output = path.join(root, "dist", "firefox-extension");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const entries = {
  "service-worker": "src/extension/service-worker.ts",
  "page-bridge": "src/extension/page-bridge.ts",
  "content-relay": "src/extension/content-relay.ts",
  dashboard: "src/extension/dashboard.ts",
};
await Promise.all(Object.entries(entries).map(([name, entry]) => build({
  entryPoints: [path.join(root, entry)],
  outfile: path.join(output, `${name}.js`),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["firefox128"],
  sourcemap: false,
  minify: false,
  legalComments: "inline",
  define: { __NATIVE_ARCHIVE__: "true" },
})));
await cp(path.join(root, "public"), output, { recursive: true });
await writeFile(path.join(output, "manifest.json"), await readFile(path.join(root, "public", "manifest.firefox.json")));
