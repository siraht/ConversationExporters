import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

const root = process.cwd();
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const release = path.join(root, "dist", "releases");
await mkdir(release, { recursive: true });
await copyFile(path.join(root, "dist", "chrome", "icon-128.png"), path.join(release, "icon-128.png"));
for (const browser of ["chrome", "firefox"]) {
  const files = {};
  for (const file of await walk(path.join(root, "dist", browser))) {
    const relative = path.relative(path.join(root, "dist", browser), file).replaceAll(path.sep, "/");
    files[relative] = [new Uint8Array(await readFile(file)), { mtime: new Date("1980-01-02T00:00:00Z") }];
  }
  await writeFile(path.join(release, `conversation-archive-${browser}-${version}.zip`), zipSync(files, { level: 9 }));
}

async function walk(directory) {
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    const candidate = path.join(directory, name);
    if ((await stat(candidate)).isDirectory()) output.push(...await walk(candidate)); else output.push(candidate);
  }
  return output;
}
