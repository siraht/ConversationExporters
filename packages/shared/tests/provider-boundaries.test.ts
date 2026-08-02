import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface Manifest {
  name: string;
  version: string;
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ matches: string[] }>;
}

describe("provider package boundaries", () => {
  it("keeps the accepted manifests, versions, and host permissions separate", async () => {
    const grok = await manifest("grok-exporter");
    const chatgpt = await manifest("chatgpt-exporter");

    expect(grok).toMatchObject({
      name: "GrokExporter",
      version: "0.1.0",
      permissions: ["storage", "tabs", "unlimitedStorage"],
      host_permissions: [
        "https://grok.com/*",
        "https://assets.grok.com/*",
        "https://imagine-public.x.ai/*",
        "https://pbs.twimg.com/*",
        "https://video.twimg.com/*",
      ],
    });
    expect(chatgpt).toMatchObject({
      name: "ChatGPTExporter",
      version: "0.1.6",
      permissions: [],
      host_permissions: ["https://chatgpt.com/*"],
    });
    expect(grok.content_scripts.flatMap((script) => script.matches)).toEqual(["https://grok.com/*", "https://grok.com/*"]);
    expect(chatgpt.content_scripts.flatMap((script) => script.matches)).toEqual(["https://chatgpt.com/*", "https://chatgpt.com/*"]);
  });
});

async function manifest(packageName: string): Promise<Manifest> {
  const url = new URL(`../../${packageName}/public/manifest.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Manifest;
}
