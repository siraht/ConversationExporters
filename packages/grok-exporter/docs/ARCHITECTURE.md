# Architecture and threat model

## Trust boundaries

GrokExporter has no backend. The dashboard, service worker, and isolated content relay execute in the extension origin; a minimal page bridge executes in Grok's `MAIN` world only because same-origin requests need the session already held by the page.

The dashboard is the only component allowed to start an export or hold the user-selected directory handle. The service worker accepts requests only from this extension's own pages, validates every path and method, and forwards them to a known `grok.com` tab. The page bridge validates the same endpoint allowlist again before calling `fetch`. A compromised web page therefore cannot use extension messaging to request an arbitrary authenticated URL.

Neither bridge code nor logs read `document.cookie`, Chrome's cookie API, request authorization headers, or browser profile files. Authentication remains an implicit browser concern.

## Data flow

```text
dashboard
  │ typed runtime request
  ▼
service worker ── validates extension sender, tab, endpoint and method
  │ tabs.sendMessage
  ▼
isolated relay ── correlates one request ID with one page response
  │ window.postMessage on grok.com origin
  ▼
MAIN-world bridge ── validates protocol and endpoint, performs same-origin fetch
```

Responses travel back through the same correlation ID. JSON responses have byte limits. Asset downloads happen in the extension dashboard from a short host allowlist, use capped streams, and revalidate the final redirected host.

## Durability model

The inventory and run journal are durable before conversation capture begins. Inventory follows the global conversation token chain, enumerates every current workspace/project, follows each workspace's own conversation token chain, and merges IDs while retaining discovered memberships. This matters because Grok's global list can return a project conversation with an empty `workspaces` field.

Each output file is committed by closing a browser filesystem writable stream. `complete.json` is written only after raw payloads, normalized JSON, Markdown, assets, and validation have finished. A restart trusts a conversation only when its completion marker matches the current listing hash, including any workspace membership discovered through scoped enumeration.

Remote deletion never triggers local deletion. A conversation absent from a later inventory moves into `missingRemoteConversationIds` while its archived files remain untouched.

## Completeness model

Conversation completeness and asset completeness are separate:

- A conversation is complete only when pagination ended normally, all response-node IDs have exactly one captured body, graph validation has no errors, and the completion marker exists.
- When workspace capture is enabled, pagination must end normally for the global list and every discovered workspace scope before the inventory can be complete.
- Assets are `complete`, `partial`, or `not_requested`. Asset failures are retained in `assets.json`, `indexes/assets.jsonl`, and the final report without misreporting a failed download as present.

Private Grok endpoints can change. Unknown envelopes, roles, and fields are preserved in raw JSON and surfaced as findings rather than guessed away.
