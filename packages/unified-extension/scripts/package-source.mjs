import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

const packageRoot = process.cwd();
const { version } = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const repository = path.resolve(packageRoot, "../..");
execFileSync(process.execPath, ["scripts/privacy-check.mjs"], { cwd: repository, stdio: "inherit" });
const names = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: repository })
  .toString("utf8").split("\0").filter(Boolean)
  .filter((name) => !name.split("/").includes("dist") && !name.split("/").includes("node_modules"));
const files = {};
for (const name of names.sort()) files[name] = [new Uint8Array(await readFile(path.join(repository, name))), { mtime: new Date("1980-01-02T00:00:00Z") }];
const release = path.join(packageRoot, "dist", "releases");
await mkdir(release, { recursive: true });
await writeFile(path.join(release, `conversation-archive-source-${version}.zip`), zipSync(files, { level: 9 }));
