#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const forbiddenPaths = /(^|\/)(private|exports?|browser-profiles?|user data)(\/|$)|\.(har|zip|crx|pem|sqlite3?|db)$/i;
const forbiddenContent = [
  /\b(authorization|x-authorization|cookie|set-cookie)\s*:/i,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /\b(sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~-]{20,})\b/i,
];
const findings = [];
for (const file of files) {
  if (forbiddenPaths.test(file)) findings.push(`${file}: forbidden private/export path`);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (file.includes("fixtures/") || file.endsWith("privacy-check.mjs")) continue;
  for (const pattern of forbiddenContent) {
    if (pattern.test(text)) findings.push(`${file}: forbidden credential-like content`);
  }
}
if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log(`Privacy check passed for ${files.length} tracked/unignored files.`);

