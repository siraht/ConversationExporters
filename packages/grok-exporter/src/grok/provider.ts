import type { ProviderDescriptor } from "@conversation-exporters/shared/provider";

export const GROK_PROVIDER = {
  id: "grok",
  archiveSchemaVersion: 1,
  displayName: "Grok",
  primaryOrigin: "https://grok.com",
  manifestHosts: [
    "https://grok.com/*",
    "https://assets.grok.com/*",
    "https://imagine-public.x.ai/*",
    "https://pbs.twimg.com/*",
    "https://video.twimg.com/*",
  ],
  conversationUrl: (conversationId: string) => `https://grok.com/c/${encodeURIComponent(conversationId)}`,
} as const satisfies ProviderDescriptor<"grok">;
