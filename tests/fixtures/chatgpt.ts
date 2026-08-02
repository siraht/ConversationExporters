import type { ChatGptConversationDetail, ChatGptConversationPage } from "../../src/chatgpt/envelopes";

export function conversationListItem(overrides: Partial<ChatGptConversationPage["items"][number]> = {}) {
  return {
    id: "conversation-1",
    title: "Synthetic conversation",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    ...overrides,
  };
}

export function conversationPage(overrides: Partial<ChatGptConversationPage> = {}): ChatGptConversationPage {
  return {
    items: [conversationListItem()],
    total: 1,
    offset: 0,
    limit: 28,
    has_missing_conversations: false,
    ...overrides,
  };
}

export function conversationDetail(overrides: Partial<ChatGptConversationDetail> = {}): ChatGptConversationDetail {
  return {
    id: "conversation-1",
    title: "Synthetic conversation",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "assistant-1",
    mapping: {
      "root-1": { id: "root-1", message: null, parent: null, children: ["user-1"] },
      "user-1": {
        id: "user-1",
        parent: "root-1",
        children: ["assistant-1"],
        message: {
          id: "message-user-1",
          author: { role: "user" },
          create_time: 1_700_000_001,
          content: { content_type: "text", parts: ["Hello from a synthetic fixture."] },
          status: "finished_successfully",
          end_turn: null,
          recipient: "all",
          metadata: {},
        },
      },
      "assistant-1": {
        id: "assistant-1",
        parent: "user-1",
        children: [],
        message: {
          id: "message-assistant-1",
          author: { role: "assistant" },
          create_time: 1_700_000_002,
          content: { content_type: "text", parts: ["Synthetic response."] },
          status: "finished_successfully",
          end_turn: true,
          recipient: "all",
          metadata: { model_slug: "synthetic-model" },
        },
      },
    },
    ...overrides,
  };
}
