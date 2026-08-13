import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const output = path.join(root, "dist", "extension");
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
  target: ["chrome120"],
  sourcemap: false,
  minify: false,
  legalComments: "inline",
  define: { __NATIVE_ARCHIVE__: "false", __BROWSER_ARCHIVE__: "false" },
})));

await cp(path.join(root, "public"), output, { recursive: true });
