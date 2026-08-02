import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

await import("./build.mjs");
const root = process.cwd();
const extensionRoot = path.join(root, "dist", "extension");
const releaseRoot = path.join(root, "dist", "releases");
const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
const files = {};

for (const name of await listFiles(extensionRoot)) {
  files[name] = new Uint8Array(await readFile(path.join(extensionRoot, name)));
}

const archive = zipSync(files, {
  level: 9,
  mtime: new Date("1980-01-02T00:00:00.000Z"),
});
await mkdir(releaseRoot, { recursive: true });
const destination = path.join(releaseRoot, `GrokExporter-${manifest.version}.zip`);
await writeFile(destination, archive);
console.log(destination);

async function listFiles(directory, prefix = "") {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) output.push(relative);
  }
  return output;
}
