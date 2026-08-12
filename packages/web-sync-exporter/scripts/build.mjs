import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const output = path.join(root, "dist", "firefox-extension");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ["background", "page-bridge", "content-relay", "dashboard"]) {
  await build({
    entryPoints: [path.join(root, "src", `${name}.ts`)],
    outfile: path.join(output, `${name}.js`),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["firefox128"],
    sourcemap: false,
    minify: false,
    legalComments: "inline"
  });
}
await cp(path.join(root, "public"), output, { recursive: true });
