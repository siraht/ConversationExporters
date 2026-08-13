import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { deflateSync } from "node:zlib";

const root = process.cwd();
const repository = path.resolve(root, "../..");
const entries = {
  background: "packages/unified-extension/src/background.ts",
  dashboard: "packages/unified-extension/src/dashboard.ts",
  "chatgpt-page-bridge": "packages/chatgpt-exporter/src/extension/page-bridge.ts",
  "chatgpt-content-relay": "packages/chatgpt-exporter/src/extension/content-relay.ts",
  "grok-page-bridge": "packages/grok-exporter/src/extension/page-bridge.ts",
  "grok-content-relay": "packages/grok-exporter/src/extension/content-relay.ts",
  "web-page-bridge": "packages/web-sync-exporter/src/page-bridge.ts",
  "web-content-relay": "packages/web-sync-exporter/src/content-relay.ts"
};

for (const browser of ["chrome", "firefox"]) {
  const output = path.join(root, "dist", browser);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await Promise.all(Object.entries(entries).map(([name, entry]) => build({
    entryPoints: [path.join(repository, entry)], outfile: path.join(output, `${name}.js`), bundle: true,
    format: "iife", platform: "browser", target: [browser === "firefox" ? "firefox128" : "chrome120"],
    sourcemap: false, minify: false, legalComments: "inline",
    define: { __NATIVE_ARCHIVE__: "false", __BROWSER_ARCHIVE__: "true" }
  })));
  for (const [provider, entry] of [
    ["chatgpt", "packages/chatgpt-exporter/src/extension/dashboard.ts"],
    ["grok", "packages/grok-exporter/src/extension/dashboard.ts"],
  ]) {
    await Promise.all([
      build({ entryPoints: [path.join(repository, entry)], outfile: path.join(output, `${provider}-dashboard.js`), bundle: true, format: "iife", platform: "browser", target: [browser === "firefox" ? "firefox128" : "chrome120"], define: { __NATIVE_ARCHIVE__: "false", __BROWSER_ARCHIVE__: "true" } }),
      build({ entryPoints: [path.join(repository, entry)], outfile: path.join(output, `${provider}-folder-dashboard.js`), bundle: true, format: "iife", platform: "browser", target: [browser === "firefox" ? "firefox128" : "chrome120"], define: { __NATIVE_ARCHIVE__: "false", __BROWSER_ARCHIVE__: "false" } }),
    ]);
  }
  await cp(path.join(root, "public"), output, { recursive: true });
  for (const size of [16, 32, 48, 128]) await writeFile(path.join(output, `icon-${size}.png`), iconPng(size));
  await writeFile(path.join(output, "manifest.json"), await readFile(path.join(root, "public", `manifest.${browser}.json`)));
  const chatgptHtml = (await readFile(path.join(repository, "packages/chatgpt-exporter/public/dashboard.html"), "utf8"))
    .replace('href="dashboard.css"', 'href="chatgpt.css"').replace('src="dashboard.js"', 'src="chatgpt-dashboard.js"')
    .replaceAll("ChatGPTExporter", "Conversation Archive · ChatGPT").replace("LOCAL ONLY", "BROWSER ARCHIVE");
  const grokHtml = (await readFile(path.join(repository, "packages/grok-exporter/public/dashboard.html"), "utf8"))
    .replace('href="dashboard.css"', 'href="grok.css"').replace('src="dashboard.js"', 'src="grok-dashboard.js"')
    .replaceAll("GrokExporter", "Conversation Archive · Grok").replace("LOCAL ONLY", "BROWSER ARCHIVE");
  await writeFile(path.join(output, "chatgpt.html"), chatgptHtml);
  await writeFile(path.join(output, "grok.html"), grokHtml);
  await writeFile(path.join(output, "chatgpt-folder.html"), chatgptHtml.replace('src="chatgpt-dashboard.js"', 'src="chatgpt-folder-dashboard.js"').replace("BROWSER ARCHIVE", "DIRECT FOLDER"));
  await writeFile(path.join(output, "grok-folder.html"), grokHtml.replace('src="grok-dashboard.js"', 'src="grok-folder-dashboard.js"').replace("BROWSER ARCHIVE", "DIRECT FOLDER"));
  await cp(path.join(repository, "packages/chatgpt-exporter/public/dashboard.css"), path.join(output, "chatgpt.css"));
  await cp(path.join(repository, "packages/grok-exporter/public/dashboard.css"), path.join(output, "grok.css"));
  for (const name of ["manifest.chrome.json", "manifest.firefox.json"]) await rm(path.join(output, name), { force: true });
}

function iconPng(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const background = [239, 93, 58, 255];
  const foreground = [20, 20, 18, 255];
  const margin = Math.max(2, Math.round(size * 0.18));
  const lineHeight = Math.max(2, Math.round(size * 0.11));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1); pixels[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const line = [0.27, 0.47, 0.67].some((position, index) => {
        const top = Math.round(size * position);
        const width = index === 1 ? size - margin * 2 - Math.round(size * 0.15) : size - margin * 2;
        return y >= top && y < top + lineHeight && x >= margin && x < margin + width;
      });
      const color = line ? foreground : background;
      const offset = row + 1 + x * 4;
      pixels.set(color, offset);
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type); const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8); return output;
}
function crc32(data) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
