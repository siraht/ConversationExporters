import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const staged = process.argv.includes("--staged");
const root = process.cwd();
const names = gitNames(staged);
const forbiddenPaths = /^(?:captures|exports|archives|private|live-data|browser-profile|research\/repos|ChatGPTExport-[^/]+)\//;
const forbiddenExtensions = /\.(?:har|crx|p12|pem|key)$/i;
const patterns = [
  {
    label: "authorization credential",
    regex: /\b(?:authorization|proxy-authorization|x-authorization)\s*[:=]\s*["']?(?:Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  {
    label: "ChatGPT session cookie",
    regex: /\b(?:__Secure-next-auth\.session-token|__Host-next-auth\.csrf-token|auth_token|_puid)=(?!\[REDACTED\])[A-Za-z0-9%._~+/=-]{12,}/gi,
  },
  {
    label: "JSON web token",
    regex: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    label: "signed URL credential",
    regex: /[?&](?:x-amz-signature|signature|sig|token)=(?!%?5B?REDACTED)[A-Za-z0-9%._~+/=-]{12,}/gi,
  },
  {
    label: "private key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    label: "common API token",
    regex: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}|xai-[A-Za-z0-9_-]{24,})\b/g,
  },
];
const findings = [];

for (const name of names) {
  if (forbiddenPaths.test(name) || forbiddenExtensions.test(name)) {
    findings.push(`${name}: private artifact path or extension is forbidden`);
    continue;
  }
  if (/^(?:package-lock\.json|dist\/|node_modules\/)/.test(name)) continue;
  let content;
  try {
    content = await readFile(path.join(root, name), "utf8");
  } catch {
    continue;
  }
  if (content.includes("\u0000")) continue;
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of content.matchAll(pattern.regex)) {
      const line = content.slice(0, match.index).split("\n").length;
      findings.push(`${name}:${line}: possible ${pattern.label}`);
    }
  }
}

if (findings.length) {
  console.error("Privacy check failed:\n" + findings.map((finding) => `- ${finding}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Privacy check passed for ${names.length} ${staged ? "staged" : "tracked/unignored"} files.`);
}

function gitNames(onlyStaged) {
  const args = onlyStaged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const output = execFileSync("git", args, { cwd: root });
  return output.toString("utf8").split("\u0000").filter(Boolean);
}

