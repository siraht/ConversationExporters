# Architecture

ChatGPTExporter separates provider access from local archive authority. A normal ChatGPT page owns authentication; the extension dashboard owns the user-selected directory; provider-specific code owns endpoint and shape interpretation; the core owns deterministic storage, hashing, journaling, and validation.

## Runtime boundaries

1. The service worker finds an open `chatgpt.com` tab and routes versioned messages. It cannot construct provider requests.
2. The isolated content relay forwards only the typed protocol and independently rejects unknown fields.
3. The `MAIN`-world page bridge obtains the short-lived session token and applies the selected workspace header inside a private closure. It resolves each operation to one exact read-only endpoint.
4. Signed file URLs remain in page-world asset sessions. Other extension contexts receive only an opaque handle and bounded base64 byte chunks.
5. The dashboard receives sanitized JSON/bytes and writes through the File System Access API. Directory handles are stored in extension-origin IndexedDB; provider credentials are never stored.

The public extension manifest requests no named browser permissions and only the `https://chatgpt.com/*` host permission. Matching-tab discovery is covered by that exact host grant; directory handles use extension-origin IndexedDB and archive bytes use the separately user-granted filesystem. It has no Grok, arbitrary-site, cookie, downloads, storage, tabs, or native-messaging permission.

## Capture sequence

Inventory is authoritative for the current expected set. Main and archived history use independent offset chains; the project index and every project conversation list use cursor chains; shared history is independently enumerated. Raw response pages are written before their IDs enter the union. Repeated pages/cursors, premature empty pages, byte/page limits, malformed envelopes, and inconclusive termination fail closed.

Conversation capture reconciles batches of at most ten IDs. Missing, duplicate, malformed, or suspicious graphs fall back to individual detail retrieval; share-only records use the share adapter. Raw listing, batch, and detail revisions are content-addressed before a raw completion marker is written.

Normalization retains every node/message and provider extension. Deterministic normalized JSON, selected-first branch-aware Markdown, assets, and metadata are written before the final completion marker. A rerun verifies hashes before skipping; damaged derived files rebuild from valid raw bytes without a detail request.

## Asset model

Message and project descriptors become logical asset records. Remote files stream in chunks to a staging path while an incremental SHA-256 is computed, then publish once under `assets/<sha256>.<extension>`. Multiple logical references may point to one physical file. Inline binaries and Canvas text use the same content-addressed store.

Per-conversation and per-project asset indexes retain provider ID, source message where applicable, safe/original name, media type, size, hash, adapter, local path, redacted raw descriptor, and explicit failure. Signed query strings never enter derived records, logs, reports, or public bridge responses.

## Independent audit

The audit compares the current inventory, completion-marker, and normalized sets; verifies every marker/file hash; traces normalized nodes and messages to raw graph IDs; hashes downloaded assets; rejects zero-byte/temporary files; and emits byte totals and stable set/index hashes. It writes:

- `reports/validation.json` and `reports/validation.md`;
- `indexes/conversations.jsonl` and `indexes/assets.jsonl`;
- `archive.json`, containing schema/version/scope/run/index identities without a raw workspace ID.

A previously completed conversation absent from the latest provider inventory remains in the import index with `absentFromCurrentInventory: true`. The exporter never deletes local archival evidence automatically.

## Archive layout

```text
ChatGPTExport-<workspace-fingerprint>/
  archive.json
  inventory.json
  source/inventory/
  source/account/
  conversations/<conversation-id>/
    source/
    raw-complete.json
    conversation.json
    conversation.md
    metadata.json
    assets.json
    complete.json
  projects/<project-id>/
  assets/<sha256>.<extension>
  indexes/
  reports/
  runs/
```

`source/` and content-addressed `assets/` are authoritative evidence. Normalized views, indexes, reports, and manifests are reproducible projections.
