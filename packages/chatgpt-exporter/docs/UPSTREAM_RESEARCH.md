# Upstream research

Verified: 2026-08-01

Upstream checkouts live under ignored `research/repos/`. They are protocol and behavior references, not runtime dependencies. A README claim is not accepted as a live ChatGPT contract until the local adapter has a synthetic fixture and either live observation or independent corroboration.

| Repository | Revision | License | Adopt or adapt | Explicitly reject |
| --- | --- | --- | --- | --- |
| `pionxzh/chatgpt-exporter` | `6b68edbe282a2c495e12bc1fc5b234c75d15e696` | MIT | Current API/type vocabulary, `Authorization` plus `X-Authorization`, workspace header behavior, main/project pagination, rate-limit handling, content references, citations, message rendering | Cookie reads, archive/delete mutations, default conversation ceilings, aggregate-download completion semantics |
| `brianjlacy/export-chatgpt` | `4cfc3f235ad41c864e7fe2369fb0037875537dbd` | MIT | Personal/Business request behavior, project discovery, file/Canvas/generated-image retrieval, deep-research task streams, resumable failure tests | Copied bearer/session tokens, environment credentials, CLI authentication, overwrite-oriented storage |
| `Siamsnus/GPT2Claude-Migration-Kit` | `857e4575ac2004e17d3e542f64a3f27c7eab77cd` | MIT | Archived/shared inventory, conversation batch retrieval, memories, custom instructions, project-discovery fallbacks | Paste-and-run delivery, DOM heuristics as proof, one large in-memory result, hard page caps |
| `siraht/GrokExporter` | local baseline `2c01972ee2fa7b4bff9bcc7bc09807f3e1a5ee29` | MIT | Inventory-first capture, journals, completion markers, hashing, safe filesystem, validation, reporting, dashboard, dual-world bridge, privacy/release tooling | Grok endpoints, Grok response graph assumptions, implicit-cookie authentication assumptions |

## Candidate ChatGPT web contracts

These paths are private web-application contracts, not OpenAI's public API. They may change without notice. Exact schemas and confidence are tracked in `CHATGPT_WEB_CONTRACT.md` as adapters are implemented.

- `/api/auth/session`: page-local short-lived access-token acquisition. The response must never cross the public extension protocol.
- `/backend-api/accounts/check/v4-2023-04-27`: accessible account/workspace discovery and account-header evidence.
- `/backend-api/conversations`: main and archived offset pagination.
- `/backend-api/conversations/batch`: bounded conversation-detail batches with per-requested-ID reconciliation.
- `/backend-api/conversation/<id>`: individual full conversation graph and batch fallback.
- `/backend-api/gizmos/snorlax/sidebar`, `/backend-api/projects`, and `/backend-api/gizmos/discovery/mine`: candidate project indexes; prefer the contract observed in the active UI.
- `/backend-api/gizmos/<id>/conversations`: project-scoped cursor pagination.
- `/backend-api/shared_conversations` and `/backend-api/share/<id>`: owned share inventory/detail.
- `/backend-api/files/download/<id>` and `/backend-api/estuary/content`: authenticated file retrieval candidates.
- `/backend-api/tasks/<id>/stream`: deep-research task evidence.
- `/backend-api/memories` and `/backend-api/user_system_messages`: auxiliary account artifacts, never substitutes for conversation inventory.

## Reuse rules

- Reimplement endpoint adapters behind local typed interfaces unless a small MIT utility is demonstrably safer to adapt.
- Add a file-level provenance comment to adapted code and retain license notices.
- Never vendor an upstream authentication flow that asks for or persists credentials.
- Never import destructive ChatGPT operations into this read-only exporter.
- Preserve unexpected provider fields and fail visibly; do not copy alternating-role or DOM-text fallbacks.
- Record live drift with synthetic/redacted fixtures before changing an adapter.
