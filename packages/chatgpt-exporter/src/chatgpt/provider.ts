import type { ProviderDescriptor } from "@conversation-exporters/shared/provider";

export const CHATGPT_PROVIDER = {
  id: "chatgpt-web",
  archiveSchemaVersion: 1,
  displayName: "ChatGPT",
  primaryOrigin: "https://chatgpt.com",
  manifestHosts: ["https://chatgpt.com/*"],
  conversationUrl: (conversationId: string) => `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
} as const satisfies ProviderDescriptor<"chatgpt-web">;
