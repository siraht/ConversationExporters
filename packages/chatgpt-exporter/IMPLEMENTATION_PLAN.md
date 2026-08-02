# ChatGPTExporter implementation plan

Status: standalone accepted; consolidation active
Started: 2026-08-01
Goal: export and independently verify every conversation exposed by all accessible ChatGPT web-history scopes without moving authentication secrets outside the authenticated page, then consolidate the proven ChatGPT and Grok implementations behind a shared core with separate least-privilege extension packages.

The completed GrokExporter plan and acceptance record are retained below as the implementation baseline. The authoritative unfinished checklist begins at **ChatGPTExporter expansion program**; agents must not redo checked Grok milestones or refactor Grok before the standalone ChatGPT acceptance gate passes.

## Outcome and success criteria

GrokExporter will be a public Chromium extension that runs against a user's already-authenticated `grok.com` tab. It will inventory the complete server-side conversation list, capture each conversation's underlying response graph and available metadata, preserve the original payloads, render deterministic portable forms, download referenced assets when possible, and write the result directly into a user-selected directory. Interrupted exports will resume without refetching unchanged conversations.

The implementation is complete only when all of the following are true:

- Conversation enumeration follows every `nextPageToken` until exhaustion and detects repeated tokens, duplicate IDs, configured safety limits, and suspicious empty pages.
- A preflight inventory is persisted before message capture begins, so the exporter has a fixed expected set and can prove whether every accessible conversation reached a terminal state.
- Each conversation preserves raw API responses as immutable source evidence and derives normalized JSON and Markdown without destroying unknown fields.
- Response-node graphs, regenerated branches, citations, attachments, workspace/project relationships, timestamps, model metadata, and deletion/temporary flags are retained whenever Grok exposes them.
- Export state is checkpointed after each durable file set; cancellation, browser restart, authentication expiry, rate limiting, and transient HTTP failures are recoverable.
- Completion requires zero unresolved conversation failures, zero unaccounted response nodes, and an explicit asset-error report. A partial run can never present itself as complete.
- No cookies, bearer tokens, personal conversations, captures, browser profiles, or export artifacts can enter Git under normal usage.
- The public repository includes reproducible builds, tests, fixtures containing only synthetic data, setup instructions, privacy and threat-model documentation, upstream attribution, and a troubleshooting protocol for Grok API drift.
- A real authenticated run downloads the owner's entire accessible history and passes inventory, conversation, response-node, file, and hash validation.

## Architecture

### 1. Extension dashboard

An extension-owned dashboard tab is the control plane. It asks the user for a destination directory through the File System Access API, displays preflight inventory and export progress, supports pause/resume/cancel/retry, and renders the final validation report. Keeping filesystem authority in an extension page avoids hundreds of browser download prompts and enables atomic per-file writes.

The selected directory handle is stored in extension-origin IndexedDB. Permission is checked on every run and explicitly requested again when the browser no longer grants access. The dashboard never displays full conversation text unless the user opens a local artifact.

### 2. Authenticated Grok bridge

A minimal bridge injected into the `MAIN` world of a `grok.com` tab performs same-origin `fetch` calls with the browser's existing session. An isolated content script validates requests and relays structured messages between the bridge and the extension service worker. Authentication values are never read, serialized, logged, or persisted.

Only allowlisted relative endpoints and methods can cross the bridge. Requests receive correlation IDs, timeouts, response size accounting, sanitized errors, and a protocol version so stale dashboard/bridge combinations fail safely.

### 3. Capture engine

The engine runs as an explicit state machine:

1. Discover the active authenticated Grok tab and verify a benign history request.
2. Enumerate `/rest/app-chat/conversations?pageSize=100&pageToken=...` to exhaustion.
3. Persist `inventory.json` and a run journal before fetching any conversation body.
4. For each new or modified conversation, fetch metadata, response nodes with `includeThreads=true`, and response bodies in bounded batches through `load-responses`.
5. Verify every requested response ID is present exactly once or record a retryable validation failure.
6. Discover referenced assets and workspace/project metadata from observed payloads; call additional endpoints only through separately tested adapters.
7. Write a staging directory for the conversation, fsync-equivalent by closing all writable streams, then write a completion marker last.
8. Update the run journal and continue at conservative concurrency.
9. Retry failures in a bounded second pass and generate the final audit report.

HTTP `429`, `408`, and `5xx` responses use capped exponential backoff with jitter and respect `Retry-After`. `401` and `403` pause the run for reauthentication. Schema or endpoint errors preserve a redacted diagnostic envelope and stop the affected adapter rather than guessing.

### 4. Persistence and output layout

The exporter writes directly to a user-selected directory:

```text
GrokExport-<account-fingerprint>/
  archive.json
  inventory.json
  runs/<run-id>.json
  conversations/<conversation-id>/
    complete.json
    metadata.json
    source/
      listing-entry.json
      conversation.json
      response-nodes.json
      responses-<batch>.json
    conversation.json
    conversation.md
    assets/
      <content-hash>.<extension>
  indexes/
    conversations.jsonl
    assets.jsonl
  reports/
    validation.json
    validation.md
    failures.jsonl
```

`source/` is append-preserving evidence. `conversation.json` is the versioned normalized form. Markdown is deterministic and includes stable message anchors, branch relationships, citations, source URLs, and relative asset links. Content hashes deduplicate assets and detect corruption. No filename depends solely on a mutable or unsafe title.

### 5. Normalized conversation model

The public schema will preserve:

- provider and schema versions;
- conversation ID, title, source URL, timestamps, flags, workspace/project references, and raw-source paths;
- ordered messages with stable IDs, roles, timestamps, model information, text/content parts, citations, attachments, generated media, tool/search metadata, parent/child relationships, and branch selection;
- unknown provider fields in namespaced extension maps when they cannot yet be modeled;
- capture provenance, raw hashes, normalization warnings, and validation results.

The model will be deliberately compatible with the unified conversation archive project, but GrokExporter will remain independently useful and will not require that backend.

### 6. Incremental and resumable behavior

The inventory entry's conversation ID, modification timestamp, listing hash, and last raw capture hash determine whether a conversation needs recapture. A run journal records state transitions rather than only a boolean success flag. Files are written using temporary sibling names and renamed only after successful closure, with `complete.json` written last.

An interrupted run revalidates existing completion markers and hashes before skipping work. Deleted remote conversations remain in the local archive and are marked absent in the latest inventory; the exporter never deletes archival data automatically.

### 7. Asset capture

Asset support is layered so text export remains reliable when media endpoints drift:

- Extract asset descriptors and URLs from raw conversation payloads.
- Resolve Grok asset-library identifiers through a narrowly scoped adapter when necessary.
- Read asset responses through a size-capped stream, hash them before naming, and commit each resulting file independently.
- Preserve failed descriptors, HTTP metadata, and retry state without storing signed URLs in public logs.
- Deduplicate by content hash while retaining per-message logical references.

Generated images, uploaded documents, audio/video, and inline data receive separate synthetic fixtures and validation cases.

### 8. Verification strategy

Unit tests cover pagination, repeated-token defense, response ordering, branch graphs, role detection, Markdown escaping, filename safety, URL redaction, retry policy, hashing, incremental decisions, and schema migration. Contract fixtures model every response envelope observed in the reference implementations without containing personal data.

Integration tests run the engine against a deterministic mock Grok server and an in-memory filesystem adapter. Browser tests load the unpacked extension in Chromium, connect it to the mock origin, interrupt a run, resume it, and compare the output tree byte-for-byte.

The real-account acceptance run records only counts and hashes in the private run report. Completeness checks compare:

- every paginated inventory ID against every local completion marker;
- every response-node ID against captured response IDs;
- declared messages/assets against normalized references and local files;
- first and last remote modification times against the archive index;
- a manual sample of short, long, branched, cited, uploaded-file, generated-image, workspace, and old conversations against the live UI.

## Reference-project fusion

Reference repositories live under ignored `research/repos/` and are never vendored wholesale.

- `llg1634/grok-full-exporter`: reuse the verified endpoint sequence, tolerant envelope reading, raw-preservation concept, and human-readable export behavior. Replace mixed `limit`/cursor pagination, the in-memory STORE ZIP, alternating-role fallback, and all-or-nothing runs.
- `communism420/All-Chats-Sidebar-for-Grok`: adopt the tested `pageSize`/`pageToken` contract, response-shape tolerance, repeated refresh behavior, and live metadata handling. Keep its role as behavioral reference rather than importing sidebar UI.
- `dotCipher/ai-vault`: adapt the workspace, project, asset, and incremental-backup concepts after verifying each endpoint. Do not inherit cookie export, headless-login maintenance, or its currently unpaginated Grok conversation list.
- `MattTheCoder556/ChatArchiver`: learn from per-conversation manifests, retryable failure handling, and scheduling. Do not copy unlicensed source, the one-request 1000-chat ceiling, or the simplified responses endpoint.
- `revivalstack/ai-chat-exporter`: use as a rendering comparison for code blocks, tables, citations, and Markdown readability. DOM extraction remains a last-resort diagnostic fallback.
- `iikoshteruu/enhanced-grok-export`: retain only lessons for older X-hosted Grok UI compatibility; heuristic speaker detection is unsuitable for archival normalization.

Any copied or adapted code requires a file-level provenance note and compatibility with this repository's license. Behavioral reimplementation is preferred when the upstream component is small.

## Dependency policy

Dependencies are accepted only when maintaining the equivalent implementation ourselves would be riskier:

- TypeScript for protocol and schema safety.
- esbuild for small deterministic extension bundles.
- Vitest for fast browser-oriented unit and integration tests.
- A mature streaming ZIP or hashing dependency only if direct directory writing cannot cover a supported browser; Chromium's Web Crypto and File System Access APIs are preferred.
- Playwright only for extension end-to-end tests, not as a runtime authentication mechanism.

Runtime code must remain small, auditable, and free of analytics, remote scripts, CDNs, update services, or backend dependencies.

## Privacy and public-release controls

- `.gitignore` excludes local checkouts, captures, exports, browser profiles, HAR files, archives, credentials, and environment overrides.
- A pre-commit privacy check scans staged content for Grok cookies, bearer tokens, conversation API responses, common personal-export paths, and high-entropy credential patterns.
- Tests use generated UUIDs, neutral prose, fake origins, and synthetic binary assets.
- Logs contain IDs only when necessary for recovery and never contain message bodies or signed asset URLs.
- The extension requests access to `https://grok.com/*` plus a short audited allowlist of Grok/X media hosts, local extension storage, and explicit user-selected filesystem destinations.
- The README will explain that Grok's web endpoints are private and can change, that users should export only accounts they are authorized to access, and that official xAI exports remain a useful independent backup.

## Delivery phases and commit strategy

Each checked item should normally correspond to one focused commit; plan/progress updates may accompany the implementation commit they describe.

### Phase A — repository and research

- [x] Initialize the repository and public/private boundaries.
- [x] Create this living implementation plan.
- [x] Clone the reference projects into `research/repos/`.
- [x] Record repository versions, licenses, endpoint behavior, reusable ideas, and rejected approaches.
- [x] Create the public package skeleton and contributor-facing documentation.

### Phase B — provider-independent core

- [x] Define versioned raw, normalized, inventory, journal, and validation types.
- [x] Implement deterministic hashing, safe paths, atomic filesystem abstraction, and redaction.
- [x] Implement pagination, retry, cancellation, rate limiting, and capture state machines.
- [x] Implement Grok envelope adapters and response-graph validation.
- [x] Implement normalized JSON and deterministic Markdown renderers.

### Phase C — extension integration

- [x] Build the allowlisted page-world API bridge and isolated relay.
- [x] Build the service-worker coordinator and authenticated-tab discovery.
- [x] Build the dashboard, directory permission flow, settings, and progress UI.
- [x] Persist the directory handle in extension-origin IndexedDB and crash-safe capture state in the archive.
- [x] Implement metadata, response, workspace/project, and asset adapters.
- [x] Add pause, resume, cancel, failure retry, and final audit UX.

### Phase D — verification and release

- [x] Add synthetic contract fixtures and comprehensive unit tests.
- [x] Add mock-server integration and Chromium extension tests.
- [x] Add privacy scanning, typechecking, build checks, and reproducible packaging.
- [x] Write installation, operation, troubleshooting, privacy, architecture, and contribution docs.
- [x] Perform a clean-room load-unpacked and mock-export acceptance test.
- [x] Perform the private real-account full-history export and completeness audit.
- [x] Create the public GitHub `GrokExporter` repository and push all public commits.

## Decision log

### 2026-07-20 — Browser-local authentication

Use a page-world bridge in the user's normal authenticated Grok tab. This avoids copying durable session cookies into configuration or an always-on VPS and follows the path already proven by the browser itself.

### 2026-07-20 — Direct directory output instead of one giant ZIP

Use a user-selected directory as the primary destination. Per-conversation atomic writes and completion markers make large archives resumable and verifiable, while a single in-memory ZIP can lose the entire run when memory, download, or browser lifetime fails.

### 2026-07-20 — Raw-first preservation

Treat normalized JSON and Markdown as derived artifacts. Grok's private schema will evolve, so retaining untouched payloads is the only reliable way to improve parsers later without re-downloading data that may have been edited or deleted remotely.

### 2026-07-20 — Public repository, private acceptance artifacts

Commit implementation, synthetic fixtures, schemas, and aggregate test logic. Keep real conversation data, account identifiers, run journals, endpoint captures, and browser state outside Git even when they appear harmless.

### 2026-07-20 — Workspace scopes are part of inventory completeness

Treat Grok UI projects as workspace records under the current web contract. Enumerate the global token chain and every workspace-specific conversation token chain, merge repeated IDs, and retain scoped memberships. A global list alone is insufficient because it can include project conversations while returning an empty `workspaces` field.

### 2026-07-20 — Live drift is repaired from raw evidence

When a live run reveals a parser or optional-adapter change, preserve the old completion evidence privately, update the smallest allowlisted adapter, and selectively recapture affected records. Raw payloads remain authoritative, while normalized JSON and Markdown are replaceable derived artifacts.

## Progress journal

### 2026-07-20

- Started Goal Mode with the entire implementation, authenticated export, verification, and public release as the completion condition.
- Confirmed `/home/travis/Projects/GrokExport` was empty, GitHub CLI is authenticated, and the requested repository can be created from this machine.
- Established ignored locations for upstream research checkouts and all private export artifacts before cloning or capturing anything.
- Cloned six reference implementations and recorded their exact revisions and licenses in `docs/UPSTREAM_RESEARCH.md`.
- Confirmed that the strongest list contract uses `pageSize` and `pageToken`, while the strongest message contract combines conversation metadata, response nodes, and batched `load-responses` calls.
- Confirmed that existing asset and workspace implementations do not yet prove complete pagination, so those endpoints will remain optional adapters until live behavior and fixtures support them.
- Added the MIT-licensed TypeScript/Manifest V3 package skeleton with an explicit zero-service, privacy-first runtime policy.
- Defined strict versioned types for inventory evidence, raw batches, normalized branch-aware conversations, validation findings, capture journals, bridge messages, settings, and archive manifests.
- Added deterministic JSON hashing, UTF-8 accounting, traversal-safe paths, media-extension mapping, signed-URL and credential redaction, sanitized errors, paced requests, capped retry behavior, and focused unit tests.
- Restricted Vitest discovery to this repository's synthetic tests because ignored upstream checkouts contain their own incompatible test suites.
- Implemented the Grok endpoint allowlist, tolerant list/node/response envelope readers, exact `pageSize`/`pageToken` inventory traversal, token-cycle and page-limit defenses, duplicate reporting, bounded response-ID batches, response cursor traversal, and synthetic transport tests.
- Added raw-first normalization for explicit roles, branch parents/children, model and timestamp metadata, citations, generated images, file attachments, workspace references, and unknown Grok extensions; unknown senders now remain visibly unknown.
- Added response-set and graph validation plus deterministic branch-aware Markdown rendering. Missing response bodies are fatal, while unexpected bodies, unknown roles, and missing graph neighbors remain explicit findings.
- Added browser-directory and in-memory archive filesystems with safe relative-path enforcement, close-before-commit writable streams, defensive byte copying, and stable JSON/JSONL serialization.
- Implemented the end-to-end capture state machine: inventory is persisted first, each conversation is journaled through capture/write/complete states, validation failures receive a bounded second pass, completion markers are written last, unchanged captures are skipped safely, and deleted remote chats remain represented as archive metadata.
- Added final JSON/Markdown audit reports, failure JSONL, compact conversation indexes, and tests proving successful capture, incremental skips, and fail-closed behavior when response bodies are missing.
- Built the Manifest V3 extension dashboard, persistent directory handle, authenticated Grok-tab discovery, pause/resume/cancel controls, and progress reporting.
- Added a dual-world request bridge with endpoint allowlists enforced in both the service worker and Grok page context. Authentication remains implicit in same-origin fetches and is never read or serialized.
- Confirmed that Chromium's writable file stream commits on successful close; the exporter then writes `complete.json` last, so a browser interruption cannot make a partial conversation look complete even without a portable filesystem rename primitive.
- Added token-complete asset-library and workspace enumeration, per-workspace project capture, raw supporting-metadata artifacts, duplicate-page defenses, and nonfatal findings when an optional Grok endpoint is unavailable.
- Added size-capped downloads from audited Grok/X media hosts, content-hash naming and deduplication, asset-record indexes, relative Markdown links, asset-ID resolution through `/rest/assets/<id>`, and explicit partial-media findings that remain separate from conversation completeness.
- Added a staged-content privacy scanner and repository-owned pre-commit hook, CI, deterministic release ZIPs, public installation/privacy/architecture/troubleshooting/contribution documentation, and a headless Chromium test that proves the real packaged extension can reuse a synthetic Grok session while rejecting arbitrary origins.
- Created the public `siraht/GrokExporter` GitHub repository and pushed the full granular implementation history without research checkouts, build products, credentials, or private archive data.
- Completed the private authenticated acceptance run: 16 global history pages produced 946 unique conversations, all 946 response graphs validated, all completion markers and normalized hashes verified, and the final report contained zero conversation failures, inventory findings, or asset failures.
- Verified 107 asset references against 100 deduplicated local files; every recorded size and SHA-256 hash matched the downloaded bytes, and no zero-byte or temporary files remained.
- Corrected live API drift after the historical nested workspace-project route returned `404`: current project records are fetched through `/rest/workspaces/<id>`, with three detail payloads captured and zero workspace findings.
- Added current `citedWebSearchResults`, `webpageUrls`, and X-post citation normalization after raw evidence exposed the newer schema; a selective resume recaptured 221 affected conversations, left 725 unchanged, and produced 6,398 citations across 218 conversations without changing the complete inventory.
- Promoted workspace-scoped conversation pagination into the inventory boundary. Three project scopes added eight memberships to already-global conversations, producing 19 pages across four exhausted token chains, eight linked conversations, and no additional unique IDs.
- Re-ran the full independent audit after every live correction: inventory, directory, JSONL index, validation, and journal ID sets were identical; listing, normalized, raw-reference, and completion-marker hashes had zero mismatches.
- Manually sampled short, long, branched, cited, uploaded-file, generated-image, old, project landing, and workspace-linked conversation views against the live UI; every selected artifact opened in Grok and the linked conversation displayed the expected project badge.
- Passed the final release gate with typechecking, 30 unit tests, the tracked-file privacy scan, the packaged Chromium bridge test, and two identical release ZIP builds. `GrokExporter-0.1.0.zip` has SHA-256 `c4957b3dfb679b651c7db2dc32eb5f26527b1829f5af30b2d74afdf039864e7a`.

## Lessons and open questions

- Existing Grok exporters prove that response-node and load-responses endpoints are more complete than DOM scraping, but their normalization frequently guesses roles when an envelope changes. Unknown roles must become warnings, not alternating assumptions.
- Conversation-list pagination is the first completeness boundary. A large page size is not a substitute for following the server's token to exhaustion.
- Current Grok UI projects are workspace records, not nested `/projects` resources. The global list does not reliably expose their memberships, so workspace-scoped list pagination is a completeness requirement rather than optional decoration.
- Current citation fields distinguish explicitly cited web results from a much larger retrieval candidate set. Normalizing `citedWebSearchResults` while ignoring uncited `webSearchResults` keeps derived output faithful and bounded.
- The authenticated acceptance run requires a signed-in Grok tab and an explicit directory grant. Chrome can persist that directory permission, while authentication remains entirely inside the normal browser profile.

## ChatGPTExporter expansion program

Status: standalone implementation complete; private full-account acceptance in progress
Added: 2026-08-01
Implementation workspace: `/home/travis/Projects/ChatGPTExport`
Final consolidation workspace: `/home/travis/Projects/ConversationExporters`
Final consolidation target: one source repository with a shared exporter core and two separately packaged least-privilege extensions

This program adds a complete ChatGPT web-history exporter without destabilizing the proven Grok exporter. It deliberately uses two stages. First, build and validate a standalone `ChatGPTExporter` sibling against a real account. Second, after both provider implementations are independently complete, extract only the demonstrated common behavior into one repository. The final repository may share nearly all capture, storage, validation, reporting, and dashboard code, but the public releases remain separate extension packages: the Grok package requests only Grok hosts, and the ChatGPT package requests only ChatGPT and audited asset hosts.

The implementation must be mechanical enough for an agent unfamiliar with the prior discussion to execute. An unchecked item is unfinished work. Research evidence, implementation, private acceptance, consolidation, documentation, and release are all part of the scope.

### 1. Non-negotiable completion contract

The expansion is complete only when every condition below is satisfied:

- A standalone Chromium `ChatGPTExporter` extension exists in `/home/travis/Projects/ChatGPTExport`, is version controlled, and can be built, tested, packaged, and loaded without depending on the Grok extension at runtime.
- The extension uses the user's already-authenticated `chatgpt.com` tab. It never asks the user to copy a bearer token, never reads browser profile files, never requests Chrome cookie permission, and never persists an access token, session token, authorization header, or cookie.
- Main-history, archived, project-scoped, shared, and every explicitly selected accessible workspace inventory chain is followed to exhaustion. Duplicate IDs, repeated cursors, suspicious empty pages, response caps, inconsistent totals, and cross-scope membership conflicts are reported.
- Every inventory item reaches a durable terminal state. A run with a missing conversation body, unaccounted graph node, invalid completion marker, or unresolved retryable conversation failure must not claim conversation completeness.
- Every accessible conversation body is preserved as raw provider evidence and normalized into deterministic JSON and readable Markdown without deleting unknown provider fields.
- Message graphs, alternate branches, author roles, timestamps, model metadata, citations/content references, browsing/tool results, code execution, Canvas content, deep-research output, generated media, uploads, audio, and other exposed content types are preserved or explicitly reported as unsupported. Unknown content is retained as namespaced raw data; it is never silently discarded or assigned a guessed role.
- Referenced files are downloaded when the authenticated web application exposes a supported retrieval path. Each asset has a byte count and SHA-256 hash. Missing, expired, unauthorized, oversized, or unsupported assets remain visible in validation evidence and cannot be reported as downloaded.
- The export is resumable across tab closure, extension restart, authentication expiry, rate limiting, and browser restart. A repeat run revalidates existing completion markers and skips unchanged complete conversations without duplicating them.
- The owner's full accessible ChatGPT history is downloaded into a private local directory and passes the acceptance audit defined below. Committed evidence contains aggregate counts and hashes only; it never contains titles, bodies, account identifiers, signed URLs, or local private export paths.
- After standalone acceptance, GrokExporter and ChatGPTExporter are consolidated into one source repository with shared core modules and two separately packaged manifests. Existing Grok archives remain readable without migration, and the previously accepted Grok behavior does not regress.
- All public code has an auditable license and provenance trail, synthetic fixtures, privacy scanning, reproducible builds, installation instructions, troubleshooting guidance, and small granular commits carrying the required plan/progress updates.

Temporary chats that ChatGPT never persisted, already-deleted chats, conversations inaccessible to the signed-in user, and organization data unavailable to that user are outside the recoverable set. The final report must name these limits instead of claiming metaphysical completeness. “Complete” means every conversation exposed by all verified inventory scopes for the selected accessible account/workspace set was captured and validated.

### 2. Safety, authorization, and repository boundaries

The following rules apply before any research clone, live endpoint observation, or implementation begins:

- Preserve `/home/travis/Projects/GrokExport` at its accepted baseline until the standalone ChatGPT exporter passes its private full-account run. Do not refactor working Grok code during ChatGPT protocol discovery.
- Create `/home/travis/Projects/ChatGPTExport` as a sibling repository. Copy only provider-independent code that is intentionally reused, retaining original Git authorship where practical and adding a provenance note for copied files.
- Put upstream checkouts under `research/repos/`; ignore that directory before cloning anything. Record exact commit, license, purpose, adopted ideas, and rejected behavior in `docs/UPSTREAM_RESEARCH.md`.
- Ignore all real exports, run journals, screenshots, HAR files, downloaded assets, browser profiles, cookies, credentials, temporary response captures, environment overrides, and user-selected output directories before a live request is made.
- Never use `document.cookie`, the Chrome cookies API, browser credential databases, copied bearer tokens, or a persistent headless login. Authentication may exist only ephemerally inside the `MAIN`-world bridge while it performs a user-authorized request.
- Never allow the dashboard, service worker, or isolated content relay to supply arbitrary URLs or arbitrary headers. Both sides of the bridge independently validate an exact method/path/body allowlist.
- Do not automate deletion, archive mutation, renaming, sharing, or any other ChatGPT write operation. The extension is read-only except for its explicitly selected local destination.
- Keep live response bodies out of console logs and committed diagnostics. Errors contain status, endpoint adapter name, bounded response size, correlation ID, and redacted schema information—not conversation text or secrets.
- Use only the account/workspace data visible to the signed-in user. Managed workspace policies remain authoritative; do not attempt administrator, compliance, or other-user access.

Before the first commit in the sibling repository, implement `.gitignore`, a staged-content privacy scanner, and a pre-commit hook. The scanner must reject known token/cookie header names, JWT-like strings, ChatGPT response envelopes, common private export directory names, HAR files, archives, browser profiles, and high-entropy secrets while allowing synthetic fixtures.

### 3. Upstream research and selective reuse

Pin these initial references, then refresh the pins once at implementation start because ChatGPT's private web schema changes frequently:

| Reference | Initial revision | License | Use | Do not inherit |
| --- | --- | --- | --- | --- |
| `pionxzh/chatgpt-exporter` | `6b68edbe282a2c495e12bc1fc5b234c75d15e696` | MIT | Current message/content-reference types, API headers, rate-limit behavior, project pagination, attachment interpretation, Markdown rendering tests | Destructive archive/delete actions, direct cookie reads, default conversation caps, single-download completion assumptions |
| `brianjlacy/export-chatgpt` | `4cfc3f235ad41c864e7fe2369fb0037875537dbd` | MIT | Main and project enumeration, Business account headers, files/Canvas/generated-image retrieval, deep-research stream capture, resumable CLI tests | Copied bearer/session tokens, environment-stored credentials, CLI authentication, overwrite-oriented storage |
| `Siamsnus/GPT2Claude-Migration-Kit` | `857e4575ac2004e17d3e542f64a3f27c7eab77cd` | MIT | Archived/shared discovery, batch detail endpoint, memories, custom instructions, multi-route project discovery | Paste-and-run delivery, one large aggregate export, unbounded in-memory accumulation, UI/DOM heuristics as proof of completeness |
| Local GrokExporter | `85922d6d307550dc046862e324a38cd68966db6d` | MIT | Filesystem abstraction, inventory-first engine, journals, hashing, validation, reporting, dashboard, bridge protocol, privacy tooling | Grok endpoint assumptions, Grok-specific graph types, implicit-cookie authentication assumptions |

Use upstream repositories as protocol and behavior references rather than runtime dependencies. Small MIT utilities may be adapted with file-level attribution. Larger components should be reimplemented against local versioned interfaces so upstream API churn cannot silently change the exporter. Run each upstream's tests when feasible and record failures; an upstream README claim is a lead, not acceptance evidence.

During research, build `docs/CHATGPT_WEB_CONTRACT.md` containing only synthetic shapes and redacted field lists. For each endpoint adapter record:

- observed purpose and owning ChatGPT UI feature;
- method, path template, query/body schema, required non-secret headers, and selected workspace behavior;
- pagination/cursor semantics and termination rule;
- expected success envelope and tolerated known variants;
- authentication, permission, rate-limit, and not-found behavior;
- maximum observed response size and configured safety limit;
- raw artifact path and normalization consumer;
- fixture and test names;
- confidence: upstream-only, live-observed, fixture-tested, or full-account-verified;
- last verified date and an explicit drift-recovery procedure.

No endpoint becomes required for completion until either the active ChatGPT UI or two independent current references corroborate it and a synthetic contract test exists. Optional endpoints may fail without losing conversation completeness only when their data is genuinely auxiliary; required inventory and conversation-detail adapters fail closed.

### 4. Standalone repository and exact module layout

Create the sibling repository with this target layout. Agents may add small supporting files, but they must not collapse provider, transport, normalization, and persistence into one script:

```text
ChatGPTExport/
  IMPLEMENTATION_PLAN.md
  README.md
  LICENSE
  package.json
  tsconfig.json
  .gitignore
  docs/
    ARCHITECTURE.md
    CHATGPT_WEB_CONTRACT.md
    INSTALLATION.md
    PRIVACY.md
    TROUBLESHOOTING.md
    UPSTREAM_RESEARCH.md
  public/
    manifest.json
    dashboard.html
    dashboard.css
  scripts/
    build.mjs
    package.mjs
    privacy-check.mjs
    test-extension.mjs
  src/
    core/
      assets.ts
      capture-engine.ts
      control.ts
      errors.ts
      filesystem.ts
      hash.ts
      json.ts
      markdown.ts
      paths.ts
      redaction.ts
      retry.ts
      serialization.ts
      types.ts
      validation.ts
    chatgpt/
      auth.ts
      client.ts
      endpoints.ts
      envelopes.ts
      inventory.ts
      normalize.ts
      assets.ts
      account-artifacts.ts
    extension/
      asset-fetcher.ts
      content-relay.ts
      dashboard.ts
      handle-store.ts
      page-bridge.ts
      protocol.ts
      service-worker.ts
    types/file-system-access.d.ts
  tests/
    fixtures/chatgpt.ts
    core/
    chatgpt/
    extension/
```

Start from the current GrokExporter build/test versions unless a verified incompatibility requires a change: Node 20+, TypeScript, esbuild, Vitest, Playwright for packaged-extension tests, and browser-native File System Access/Web Crypto APIs. No new runtime package is allowed merely for convenience. `fflate` may remain only if a verified compatibility/export mode needs streaming archive support; direct directory output remains authoritative.

During standalone development, keep ChatGPT-specific discriminated types rather than prematurely making every Grok type generic. The standalone implementation should reveal the actual shared seams. Generic provider interfaces are introduced only in the consolidation phase.

### 5. Authentication and dual-world bridge protocol

ChatGPT's browser backend generally requires a short-lived access token and may require a workspace/account header. The implementation must hide those details inside the page world:

1. The dashboard finds a normal signed-in `https://chatgpt.com/` tab through the service worker.
2. The isolated relay and service worker accept only versioned request descriptors such as `session_probe`, `accounts_list`, `conversation_page`, `project_page`, `conversation_batch`, `conversation_detail`, `shared_detail`, `account_artifact`, and `asset_download`.
3. The `MAIN`-world bridge obtains `/api/auth/session` for itself, extracts the access token into a closure-local variable, observes its expiry, and refreshes it when needed. The session response and token never cross `window.postMessage`, extension messaging, IndexedDB, the filesystem, logs, or error objects.
4. The bridge adds the currently verified authorization headers. If ChatGPT requires both `Authorization` and `X-Authorization`, set both only inside the page bridge.
5. The bridge discovers accessible account/workspace metadata through the current account-check endpoint. The dashboard presents sanitized workspace labels and non-secret IDs for explicit selection. Do not read the active-workspace cookie; the user selection determines the `ChatGPT-Account-Id` header.
6. The bridge returns only the requested JSON or bounded asset bytes plus status, content type, byte count, retry metadata, and correlation ID. It strips authorization-bearing headers from all returned metadata.
7. `401` pauses for sign-in or token refresh. `403` distinguishes workspace permission from expired authentication where possible. `429` respects `Retry-After`; `408` and `5xx` use capped exponential backoff with jitter. Schema errors stop the affected adapter without fallback guessing.

Implement the allowlist with URL parsing and strict identifier validation. Reject absolute URLs, protocol-relative URLs, path traversal, duplicate sensitive query keys, unexpected methods, unexpected request bodies, and redirects to unaudited origins. Asset redirects are separately validated against a short host/media allowlist and size cap. Add tests proving that a compromised ChatGPT page cannot ask the extension to fetch localhost, arbitrary internet origins, extension URLs, or local files.

The bridge preflight must prove all of the following before directory selection or capture begins:

- an authenticated session is available;
- the selected account/workspace exists and is accessible;
- a one-item conversation request succeeds or returns a recognized empty account;
- the extension build and bridge protocol versions match;
- no token/session value appears in any message observable by the service worker test harness.

### 6. Inventory model and completeness boundary

Inventory is the authoritative expected set. Do not begin body capture until all enabled required scopes have reached a normal terminal page and `inventory.json` has been committed.

Use an account-scoped logical key such as `<workspace-fingerprint>/<conversation-id>` so identical provider IDs in different workspaces cannot collide. The fingerprint must be a one-way stable hash of the selected non-secret account/workspace ID; do not expose raw account IDs in directory names or public reports.

Implement scope adapters in this order, verifying the live UI contract before locking each path:

1. **Main history:** paginate the current `/backend-api/conversations` offset/limit contract in updated order. Continue until the server's terminal page, not a configured default cap. Defend against repeated pages, duplicate-only pages, changing totals, offset stalls, and suspicious empty pages followed by a claimed remainder.
2. **Archived history:** independently paginate the archived filter. Merge IDs already seen in main history while retaining `archived` membership and the raw archived listing entry.
3. **Projects:** discover all accessible project/GPT workspace records through the current sidebar/index contract. Follow each project's own cursor chain to exhaustion. Merge IDs but retain every project ID/name relationship and the scope page that proved it. A project listed under collapsed or “more” UI sections must still be discovered through the server contract.
4. **Shared conversations:** enumerate the user's shared-conversation list if the endpoint remains accessible. Link a share record to an already-owned conversation when the provider supplies `conversation_id`; capture share-only detail separately when it is genuinely distinct.
5. **Selected workspaces/accounts:** run scopes 1–4 separately for every workspace the user explicitly selected. Personal and Business histories are not assumed to share inventory.
6. **Auxiliary account artifacts:** after conversation inventory is durable, capture memories, custom instructions/user system messages, and useful settings as separately validated account artifacts. They do not count as conversations and cannot hide conversation failures.

Each `InventoryPageRecord` stores scope, page/cursor request, returned next cursor, item count, response byte count, raw response hash, ordered ID hash, duplicate count, and termination reason. Persist raw page payloads privately under `source/inventory/<scope>/`. The final inventory stores the union plus source memberships and completeness for every chain.

Default safety limits prevent infinite loops but never silently truncate. Hitting a maximum page, conversation, byte, or duration limit makes the scope incomplete and requires an explicit operator increase followed by resume. No implementation may use “three duplicate pages,” `1000`, or any other heuristic as a successful termination condition unless live evidence proves that condition is the provider's declared contract.

### 7. Conversation capture and raw evidence

Prefer the current batch-detail endpoint when it returns complete graph-equivalent payloads, using conservative batches no larger than the verified server limit. Preserve each batch response and mapping from requested IDs to returned records. Fall back to `/backend-api/conversation/<id>` for omitted, failed, oversized, or schema-incompatible entries. A batch HTTP success is not proof that every requested conversation was returned.

For each conversation:

- preserve the exact selected listing entries and source memberships;
- preserve the raw detail payload and any batch envelope that carried it;
- retain the full mapping/node graph, including inactive branches and provider-selected current node;
- validate that every mapping key matches its embedded node/message ID where applicable;
- validate parent and child references, roots, cycles, orphans, duplicate nodes, and selected path consistency;
- preserve conversation-level flags, moderation state, plugin/GPT/project references, timestamps, model defaults, safe URLs, and unknown fields;
- write raw files before derived files, then write `complete.json` only after normalization and validation succeed;
- record the raw hash in the run journal so future parser upgrades can rebuild derived files without refetching.

The capture engine writes a journal transition before network work (`pending → capturing`), before derived output (`capturing → writing`), and after the completion marker closes (`writing → complete`). A crash between stages must leave enough information to retry without trusting partial files. Never overwrite raw evidence in place; recaptures use timestamped/hash-addressed raw revisions and update derived current views only after validation.

Incremental comparison uses conversation ID, workspace/scope memberships, remote update time when reliable, canonical listing hash, latest raw detail hash, normalizer version, and completion-marker hash. A changed normalizer rebuilds derived files from raw data without a network fetch. A changed listing with an unchanged body writes a new listing revision and completion marker without duplicating assets.

### 8. ChatGPT normalization requirements

Implement `src/chatgpt/normalize.ts` as a loss-aware mapping from provider graph records to the normalized schema. It must support the following without relying on rendered DOM text:

- roles: user, assistant, system, tool, and unknown, preserving provider author names and metadata;
- content types: text, multimodal text, code, execution output, tether/browsing results, citations/content references, thoughts/reasoning summaries when exposed, Canvas content, image/audio/video/file pointers, tool calls/results, deep-research records, and unknown content parts;
- stable message ID, parent ID, child IDs, root IDs, selected/current branch state, timestamps, recipient, model slug, status, end-turn flags, and finish details;
- current and legacy citation encodings, including `content_references`, grouped sources, footnotes, safe URLs, tether metadata, and inline citation markers;
- project/GPT metadata and per-conversation scope memberships;
- attachment descriptors with provider file/asset IDs, names, media types, sizes, source message, logical kind, resolved local hash/path, and raw descriptor;
- provider fields that are not normalized under `extensions.chatgpt`, with binary/base64 payloads externalized rather than embedded;
- explicit findings for malformed timestamps, unknown roles, missing graph neighbors, unhandled content types, citation range mismatches, attachment resolution failures, and branch ambiguity.

Do not flatten the graph into alternating user/assistant messages. Markdown renders the provider-selected branch first and includes an explicit branch appendix or stable links for alternatives. JSON preserves every node. Unknown nodes stay in JSON and appear as bounded warnings in Markdown rather than disappearing.

Derived output must be deterministic: stable object key ordering, LF line endings, stable heading/message anchors, canonical timestamps, escaped unsafe HTML, relative asset links, and no current clock values except capture metadata. Running normalization twice over identical raw bytes and version must produce byte-identical JSON and Markdown.

### 9. Files, generated media, Canvas, and deep research

Asset capture must cover every descriptor shape found by current fixtures and the private run:

- user uploads and ordinary conversation files;
- generated images and image asset pointers;
- Canvas/textdoc/code artifacts and their current content;
- audio/video or voice artifacts when downloadable;
- browsing/deep-research attachments and task stream results;
- provider download records that return a short-lived signed URL;
- inline base64/data payloads, which are decoded to files and replaced by hashes in normalized output.

Resolve files through narrowly scoped adapters such as the current authenticated file-download and estuary/content contracts. The page bridge may follow a server redirect only after validating the final origin against the asset allowlist. Stream or chunk bytes where the browser API permits; enforce configured per-file, per-conversation, and per-run byte ceilings. Determine extensions from verified media type and magic bytes when possible, never solely from an untrusted filename.

Hash bytes before final naming. Deduplicate physical files by SHA-256 while retaining a logical record for every message reference. Store original safe filename, media type, byte size, provider ID, source message, retrieval adapter, and status in `assets.json` and `indexes/assets.jsonl`. Redact signed query parameters from reports and errors; raw private provider payloads may retain them as evidence under the archive's private boundary.

Asset status is `complete`, `partial`, or `not_requested` independently from conversation-body completeness. The final run can claim every conversation captured while reporting asset failures only if the UI and report say “conversation complete, assets partial” and enumerate every failed descriptor. The goal's preferred terminal state is zero asset failures; any genuinely irretrievable asset requires an explicit documented exception rather than silent completion.

### 10. Standalone archive layout and unified-archive compatibility

Use this account-scoped layout:

```text
ChatGPTExport-<workspace-fingerprint>/
  archive.json
  inventory.json
  source/
    inventory/<scope>/<page>.json
    account/session-metadata.json
    account/memories.json
    account/custom-instructions.json
  runs/<run-id>.json
  conversations/<conversation-id>/
    complete.json
    metadata.json
    source/
      listing-<hash>.json
      detail-<hash>.json
      batch-<hash>.json
      deep-research-<task-hash>.json
    conversation.json
    conversation.md
    assets.json
    assets/<sha256>.<extension>
  indexes/
    conversations.jsonl
    messages.jsonl
    assets.jsonl
    projects.json
  reports/
    validation.json
    validation.md
    failures.jsonl
    reconciliation.json
```

`archive.json` records schema versions, provider, hashed workspace identity, selected scopes, extension version, normalizer version, run lineage, and current index hashes. It contains no bearer/session token and no raw account ID. `source/` is append-preserving. Normalized views and indexes are rebuildable.

Provide an explicit compatibility exporter or adapter for `/data/projects/agent_session_migration` rather than constructing a giant in-memory `conversations.json`. Preferred integration is a new directory/JSONL variant in the existing `chatgpt-web` adapter that consumes per-conversation raw files and registers local asset hashes. If an official-shape aggregate file is offered for interoperability, generate it as an optional streaming derived artifact and never make it the authoritative archive.

Unified-archive acceptance must prove that importing the ChatGPTExporter directory creates one logical conversation per completion marker, preserves branches/citations/assets, creates zero new versions on unchanged reimport, and produces new versions only for changed normalized content. Personal fixture/output data remains private and uncommitted.

### 11. Dashboard and operator experience

Adapt the existing dashboard rather than inventing a second control model. It must expose:

- authenticated-tab and selected-workspace status without displaying email addresses or tokens;
- directory selection and persisted permission state;
- enabled scopes: main, archived, projects, shared, account artifacts, and assets;
- preflight endpoint/permission results;
- inventory progress per scope and total unique conversations;
- capture counts: pending, active, complete, unchanged, retryable failure, terminal failure;
- conversation and asset byte totals without message previews;
- request delay/concurrency controls with conservative defaults;
- pause before next request, resume, cancel, retry failures, and revalidate-only actions;
- clear distinction among complete, incomplete, conversation-complete/assets-partial, and authentication-required;
- final links/instructions for `reports/validation.md`, failures, and unified-archive ingestion.

The default flow is: open signed-in ChatGPT tab → open extension dashboard → select workspace(s) → choose a dedicated archive directory → run preflight → build and confirm inventory → start/resume capture → review final audit. Do not require DevTools. Do not expose archive/delete controls inherited from upstream userscripts.

### 12. Testing program

Tests are implementation requirements, not cleanup work. Add them alongside each module.

**Unit tests** must cover:

- endpoint allowlists, safe identifiers, request body schemas, workspace headers, and redirect rejection;
- session token confinement—instrument the bridge and assert that token-like values never cross its public protocol;
- main/archived offset pagination, project/shared cursor pagination, repeated-page defense, duplicate merging, page-limit failure, and suspicious empty-page behavior;
- tolerant envelope reading with explicit unknown shapes;
- batch-detail partial returns and per-conversation fallback;
- graph roots, branches, cycles, missing parents/children, duplicate IDs, selected paths, and unknown roles;
- every known content/citation/attachment variant plus future unknown blocks;
- deterministic JSON/Markdown, unsafe titles, path traversal, Unicode filenames, and malformed timestamps;
- retries, `Retry-After`, cancellation, authentication pause, response byte limits, and redacted errors;
- journal transitions, interrupted writes, completion-marker verification, changed-content versions, derived-only rebuilds, and remote deletion retention;
- asset hashing, redirect allowlists, signed-URL redaction, content-type/extension handling, deduplication, partial failures, and inline data externalization.

**Integration tests** must run the capture engine against a deterministic mock ChatGPT transport and in-memory filesystem. Required scenarios include:

- empty account;
- one ordinary conversation;
- more conversations than one page;
- archived duplicates and project-only discoveries;
- multiple projects and multiple selected workspaces;
- batch endpoint omitting one requested ID;
- branched conversation with inactive nodes;
- citations, browsing, tools, Canvas, deep research, generated image, upload, inline binary, and an unknown future content type;
- injected `401`, `403`, `429`, `5xx`, timeout, malformed JSON, oversized response, and browser cancellation;
- interruption after inventory, raw write, derived write, and asset write, followed by successful resume;
- remote-deleted conversation retained locally;
- full unchanged repeat producing no new conversation capture and byte-identical derived files.

**Packaged-extension tests** load the release build in Chromium against a mock origin. Prove the dashboard/service-worker/content-relay/page-bridge chain, authenticated-session reuse, directory permission flow, malicious endpoint rejection, pause/resume, and output tree hashes. Playwright is test-only; it must not carry real authentication at runtime.

**Privacy and release tests** scan tracked/staged content, run TypeScript with no errors, execute all unit/integration/browser tests, build twice, and require byte-identical release packages. Inspect the final manifest permissions manually.

### 13. Private authenticated acceptance run

The real-account run is a mandatory milestone and the goal cannot complete before it passes. It requires the user to be signed into the intended ChatGPT account/workspace in a normal supported Chromium browser and to grant a private destination directory. If interaction is required, pause and ask only for sign-in or directory permission; never request a token or cookie.

Run acceptance in this order:

1. Create or identify a small synthetic ChatGPT conversation exercising text and one harmless attachment. Use it for live contract calibration so initial diagnostics do not need personal conversation bodies.
2. Run preflight for every selected workspace and record endpoint status, selected scope set, extension hash, and aggregate workspace fingerprints privately.
3. Complete inventory only. Review page termination, unique counts, duplicates, scope counts, project counts, first/last timestamps, and any warnings before body capture.
4. Persist the inventory and start capture at conservative request pacing. Do not run multiple exporters concurrently.
5. On live schema drift, preserve the failed raw/redacted evidence privately, add the smallest fixture and adapter change, commit it, and resume. Never hot-edit the output or mark a failed record complete.
6. Retry every retryable conversation and asset failure. Reauthenticate through the normal page when required.
7. Run the independent audit and a no-change resume.
8. Import the completed archive into the unified conversation archive and verify idempotence and searchability.

The independent audit must verify:

- every required inventory chain terminated normally;
- the inventory set, completion-marker set, normalized-directory set, and conversations index set are identical;
- every completion marker references existing raw and derived files whose sizes and SHA-256 hashes match;
- every expected graph node appears exactly once or is covered by a documented provider omission;
- every normalized message traces to a raw node and every local asset traces to a message descriptor;
- every downloaded asset hash/size matches its bytes and there are no zero-byte or temporary files;
- failures contain zero unresolved conversation failures and, preferably, zero asset failures;
- the unchanged repeat adds zero conversations, performs no unnecessary detail fetches, and produces identical normalized/index hashes;
- project and archived memberships match a manual UI sample;
- a manual sample covers short, long, old, new, branched, archived, project, cited/browsed, tool/code, uploaded-file, generated-image, Canvas, deep-research, and shared conversations when those categories exist;
- optional official data export, if it later arrives, is compared as independent evidence without overwriting browser-exported raw data;
- the unified archive can retrieve known sanitized search probes from the imported ChatGPT corpus with provider, conversation, and raw provenance.

Commit only aggregate evidence: counts per scope/content category, number of pages, complete/failed/partial counts, aggregate bytes, set hashes, release hash, and test totals. Do not commit conversation IDs, titles, prompts, responses, account IDs, file names, local destination paths, or signed URLs.

### 14. Consolidation after standalone acceptance

Do not start this section until the standalone ChatGPT acceptance report says every accessible conversation is complete. Tag the accepted standalone revisions of GrokExporter and ChatGPTExporter first so regressions can be bisected.

Create one consolidated source repository with the following conceptual packages:

```text
conversation-exporters/
  packages/
    core/                 # hashing, filesystem, journal, retry, validation, reports
    dashboard/            # provider-neutral controls and rendering
    provider-grok/        # Grok endpoints, envelopes, normalization, asset rules
    provider-chatgpt/     # ChatGPT auth, endpoints, envelopes, normalization, asset rules
    extension-runtime/    # validated relay/service-worker/page-bridge primitives
  extensions/
    grok/                 # Grok-only manifest and branding
    chatgpt/              # ChatGPT-only manifest and branding
  tests/
    contract/
    integration/
    packaged/
```

Extract a capability-oriented provider interface based on behavior shared by both accepted implementations. At minimum it should define provider identity, origin/manifest hosts, preflight, account selection, inventory scopes, conversation capture, supporting metadata, normalization, asset descriptors, source URL construction, and validation hooks. Do not force Grok token pagination and ChatGPT offset/cursor pagination behind one leaky method; expose an async inventory-page iterator with provider-owned cursor evidence.

Generic core records change `provider: "grok"` into a versioned provider identifier while preserving schema-v1 Grok deserialization. Add migration tests that read an existing Grok archive and produce byte-identical normalized/index views when no migration is necessary. Never rewrite raw Grok evidence merely to adopt the common repository.

Keep two manifests and release artifacts:

- `GrokExporter-<version>.zip` requests only `grok.com` and audited Grok/X asset hosts;
- `ChatGPTExporter-<version>.zip` requests only `chatgpt.com` and audited ChatGPT asset hosts.

The dashboard can share source and branding variables, but it must not offer a provider whose manifest lacks that provider's host permissions. A combined personal build may be documented later, but it is not the public default and is not required for completion.

Consolidation acceptance requires:

- all standalone Grok and ChatGPT tests ported and passing;
- packaged bridge tests for both manifests;
- identical output hashes for the complete synthetic golden corpora before and after extraction;
- the existing private Grok archive revalidation remains healthy;
- the accepted private ChatGPT archive revalidation remains healthy;
- no host-permission expansion in either package;
- reproducible packages and updated attribution/license notices;
- clear upgrade instructions that do not require moving private archives.

Only after those checks pass may the standalone repositories be marked maintenance-only or redirected to the consolidated source. Preserve their tags and release artifacts.

### 15. Delivery phases and granular commit map

Agents must update the progress journal, decision log, and lessons after each meaningful milestone. Each line below normally maps to one focused commit; split further when a diff mixes independent behavior. Run the nearest tests before every commit and the full gate at phase boundaries.

#### Phase CG-A — baseline and privacy boundary

- [x] Record clean status, current commit, build hash, package hash, and full test results for GrokExporter.
- [x] Create `/home/travis/Projects/ChatGPTExport`, initialize Git, add license/package skeleton, and establish ignore/privacy scanning before research or live data.
- [x] Copy the minimal proven core/build/dashboard files with provenance notes and prove the empty extension builds.
- [x] Clone and pin upstream references under ignored paths; write the research/license matrix.
- [x] Add this ChatGPT plan to the sibling repository and make it the goal's authoritative checklist.

#### Phase CG-B — types, protocol, and authentication

- [x] Define ChatGPT raw/inventory/journal/normalized/asset/account-artifact schemas and synthetic fixture builders.
- [x] Define typed bridge requests/responses and enforce the endpoint/method/body allowlist in service worker and page world.
- [x] Implement ephemeral `/api/auth/session` handling and tests proving tokens never leave the page bridge.
- [x] Implement account/workspace discovery and explicit selection without cookie reads.
- [x] Implement preflight, reauthentication pause, rate-limit handling, error redaction, and malicious-request tests.

#### Phase CG-C — complete inventory

- [x] Implement main-history pagination with raw page evidence and fail-closed limits.
- [x] Implement archived-history pagination and membership merging.
- [x] Implement project discovery and every project cursor chain.
- [x] Implement shared-conversation inventory and ownership linking.
- [x] Implement multi-workspace inventory, stable workspace fingerprints, and collision-safe logical keys.
- [x] Persist inventory before capture and add reconciliation/page-termination reports.

#### Phase CG-D — capture, normalization, and assets

- [x] Implement batch conversation retrieval with missing-ID detection and detail fallback.
- [x] Implement append-preserving raw revisions, journal transitions, completion markers, and resume.
- [x] Implement graph validation and loss-aware message/content normalization.
- [x] Implement deterministic branch-aware Markdown and normalized JSON.
- [x] Implement citation/content-reference, browsing/tool/code, Canvas, deep-research, and unknown-block handling.
- [x] Implement upload/generated-media/audio/video/inline asset extraction and safe authenticated downloads.
- [x] Implement content hashing, deduplication, signed-URL redaction, asset indexes, and partial-asset reporting.
- [x] Implement auxiliary memories/custom-instructions/settings capture separately from conversations.

#### Phase CG-E — dashboard, integration, and release-quality verification

- [x] Adapt the dashboard for workspace selection, scope status, inventory confirmation, capture progress, and explicit terminal states.
- [x] Add deterministic mock transport integration cases for every required scope/content/failure mode.
- [x] Add packaged Chromium bridge tests and directory-permission/resume acceptance.
- [x] Add unified-archive directory adapter/compatibility output and idempotent import tests.
- [x] Write installation, architecture, web-contract, privacy, troubleshooting, and contribution documentation.
- [x] Pass typecheck, all tests, privacy scan, two identical builds, and manual manifest-permission review.
- [x] Create and push the public `ChatGPTExporter` repository only after the tracked-tree privacy audit passes.

#### Phase CG-F — private full-account completion

- [x] Calibrate against one synthetic live conversation without retaining credentials.
- [x] Inventory every selected accessible ChatGPT workspace and review termination evidence.
- [x] Download every inventoried conversation and referenced asset with resumable checkpoints.
- [x] Resolve live drift through fixtures, small commits, and selective resume.
- [x] Reach zero unresolved conversation failures and document any irretrievable asset exceptions.
- [x] Run set/hash/graph/asset reconciliation, unchanged-repeat verification, and category-based manual UI sampling.
- [x] Import into the unified archive, prove unchanged reimport creates zero versions, and run sanitized search probes.
- [x] Commit aggregate-only acceptance evidence and tag the accepted standalone release.

#### Phase CG-G — one shared source tree, separate safe releases

- [ ] Tag/reverify the accepted Grok baseline and ChatGPT standalone baseline.
- [ ] Create the consolidated repository/package layout without changing provider behavior.
- [ ] Extract generic core, dashboard, and extension runtime modules with compatibility tests.
- [ ] Move Grok and ChatGPT logic into provider packages and retain provider-owned pagination/auth semantics.
- [ ] Produce Grok-only and ChatGPT-only manifests/releases with no permission expansion.
- [ ] Prove synthetic output equivalence and revalidate both private archives.
- [ ] Update documentation, attribution, upgrade paths, CI, privacy scanning, and reproducible release packaging.
- [ ] Mark the plan complete only when every checkbox and completion-contract item has evidence.

Suggested Conventional Commit sequence begins with `chore(chatgpt): establish private-data boundary`, then uses narrow `research`, `feat`, `fix`, `test`, `docs`, and `refactor(core)` commits. Every commit must add `Co-Authored-By: OpenAI Codex <codex@openai.com>` when authored by Codex. Never combine personal export artifacts with a source commit.

### 16. ChatGPT-specific decision log

#### 2026-08-01 — Standalone proof before shared-core extraction

Build ChatGPTExporter independently until the complete private account export passes. ChatGPT's token-bearing page bridge, mixed offset/cursor inventory, and content graph differ enough from Grok that abstracting first would encode guesses and risk the working Grok implementation.

#### 2026-08-01 — One eventual source repository, two extension manifests

Consolidate proven common code into one repository, but package separate Grok and ChatGPT extensions. This obtains maintenance reuse without granting either extension unnecessary cross-provider host permissions.

#### 2026-08-01 — Page-local ephemeral ChatGPT access token

Allow the `MAIN`-world bridge to obtain and use the short-lived ChatGPT access token internally because the backend requires it. Never return, persist, log, or ask the user to copy that token. This preserves the security property that authentication remains inside the already-authenticated page.

#### 2026-08-01 — Inventory union defines accessible completeness

Define the expected set as the union of every normally terminated main, archived, project, shared, and selected-workspace scope. Do not treat sidebar visibility, one large list request, a default cap, or a heuristic duplicate-page stop as proof of completeness.

#### 2026-08-01 — Raw provider graph remains authoritative

Preserve each raw listing/detail/batch revision and treat normalized JSON, Markdown, indexes, and unified-archive projections as rebuildable. ChatGPT content/citation/file shapes evolve, and raw evidence permits later correction without losing inaccessible or deleted conversations.

#### 2026-08-01 — Read-only browser API surface

Exclude archive, delete, rename, share, and edit endpoints even when an upstream exporter implements them. The local filesystem is the only mutable target authorized by this plan.

### 17. Progress-journal template for the new work

Append dated entries here and copy them into the sibling plan. Each entry must state:

- milestone and commit hash;
- exact tests/gates run and results;
- endpoint/fixture confidence changes;
- aggregate live counts only when applicable;
- deviations or failures and their root causes;
- decisions made and the next concrete step;
- whether any user action such as sign-in or directory permission is required.

The first implementation entry should record the Grok baseline, sibling repository initialization, upstream pins, privacy exclusions, and the persistent goal ID. Later entries must never claim “all chats downloaded” until the independent reconciliation and unchanged-repeat checks pass.

### 2026-08-01 — ChatGPT implementation began

- Created persistent goal `019f8070-7650-7d32-9078-e19f06f2557c`; its completion condition includes the private real-account download, independent reconciliation, unchanged repeat, unified-archive import, and final shared-core consolidation.
- Verified GrokExporter source baseline `85922d6d307550dc046862e324a38cd68966db6d` with 30/30 tests, typechecking, privacy scan over 58 tracked/unignored files, extension build, and release package SHA-256 `c4957b3dfb679b651c7db2dc32eb5f26527b1829f5af30b2d74afdf039864e7a`. The plan-only baseline commit is `2c01972ee2fa7b4bff9bcc7bc09807f3e1a5ee29`; source and package bytes are unchanged.
- Initialized `/home/travis/Projects/ChatGPTExport` with the privacy boundary before upstream research or live access. Commits `c703807`, `33eb95e`, and `a803813` establish ignores/scanning/hooks, adopt the authoritative plan, and pin the MIT research references.
- Confirmed `research/repos/` is ignored and contains the exact upstream revisions in the research matrix. No ChatGPT authentication, endpoint, account, or conversation data has been accessed.
- Next: copy the minimal build/dashboard/core baseline with provenance, replace Grok branding and host permissions with a no-network ChatGPT skeleton, and prove the packaged extension before implementing authentication.

### 2026-08-01 — No-network extension baseline proven

- Commit `0867794` adds the minimal MV3 build/package/dashboard/runtime shape adapted from GrokExporter, with source-level provenance comments and ChatGPT-only `https://chatgpt.com/*` host permission.
- The baseline intentionally performs no authenticated fetches: every API request fails closed with `ENDPOINTS_NOT_IMPLEMENTED`, while the service worker can discover an open ChatGPT tab and the dashboard can persist a user-selected directory handle.
- Passed TypeScript checking, 2/2 focused unit tests, privacy scanning over 24 tracked/unignored files, production build, and a packaged headless-Chromium extension test against a synthetic HTTPS `chatgpt.com` origin.
- Two consecutive packages produced SHA-256 `1ac94298f2e3cd59207fc3fcc738c8fd0489bcd61d9cedbf148f6d16c524a394`. No ChatGPT authentication or personal conversation data was accessed.
- The test runner now explicitly scopes Vitest to this repository's tests so ignored upstream Jest suites cannot be collected, and it locates a Playwright Chromium installation without depending on branded Chrome's extension behavior in headless mode.
- Next: define the complete provider schemas and typed allowlisted transport, then prove page-local ephemeral authentication with synthetic tests before touching a live account.

### 2026-08-01 — Provider schemas and page-local authentication implemented

- Commit `89ba629` defines versioned archive, inventory-page, capture-journal, normalized graph, asset, workspace, account-artifact, and manifest types plus runtime validators for current ChatGPT listing/detail/account/session envelopes and reusable synthetic graph fixtures.
- Commit `ede1072` replaces the arbitrary-path baseline with typed operation descriptors. The dashboard-side request cannot specify a URL, method, headers, or arbitrary body; the service worker, isolated relay, and page bridge validate the descriptor independently, and the page bridge alone resolves the endpoint.
- `PageLocalAuth` fetches `/api/auth/session`, retains its access token only in a private page-world field, refreshes near expiry, clears it on authentication failure, and exposes only sanitized expiry metadata across the bridge.
- Passed TypeScript checking, 15/15 unit tests, privacy scanning over 32 tracked/unignored files, production build, and a packaged Chromium test that exercises a synthetic session and authenticated conversation listing. The browser test proves the token is absent from observable extension responses and rejects an injected arbitrary origin/path request.
- Fixed a browser-only binding failure discovered by the packaged test: native `window.fetch` is now invoked through a closure so it retains the correct receiver. No live account or private conversation data was accessed.
- Next: complete every remaining endpoint descriptor, implement sanitized multi-workspace discovery and explicit selection, then add preflight/error/rate-limit/malicious-request coverage before live calibration.

### 2026-08-01 — Workspace selection and CG-B preflight gate completed

- Commit `fe80151` completes the typed JSON endpoint set needed by later phases: main/archived listings, project index and project conversations, shared listings/details, batch and single details, account artifacts, and authenticated file-download descriptors. Exact identifier/cursor/page/batch constraints construct every method, path, query, and body inside the page bridge.
- Added `ChatGptClient`, stable SHA-256 workspace fingerprints, sanitized workspace labels, deactivated-account rejection, explicit dashboard selection, and revalidation of the selected account against a one-item listing or a server-declared empty history.
- The dashboard keeps directory selection disabled until workspace preflight succeeds. Authentication expiry requests a normal ChatGPT refresh/sign-in; rate limits preserve only bounded cooldown metadata; error response bodies and account IDs are excluded from logs.
- Passed TypeScript checking, 19/19 unit tests, privacy scanning over 34 tracked/unignored files, production build, and packaged Chromium UI/bridge acceptance. Malicious cases cover arbitrary/localhost/protocol-relative URL fields, destructive methods/bodies, caller-supplied headers, traversal identifiers, unknown fields, oversized pages/batches, and duplicate batch IDs.
- The browser fixture additionally proves a `429` response preserves `Retry-After` while dropping its private body, and that workspace discovery requires a user-visible explicit selection before preflight. No live account or private conversation data was accessed.
- Next: implement inventory-first main and archived pagination with append-preserving raw page evidence, fail-closed safety limits, deterministic page hashes, normal termination proof, and reconciliation before adding projects/shared/multi-workspace union behavior.

### 2026-08-01 — Complete per-workspace inventory engine implemented

- Commit `bf31cb2` adapts the proven Grok archive filesystem, safe-path, stable-JSON, byte-count, and SHA-256 primitives with file-level provenance; commit `6464494` implements ChatGPT inventory across main, archived, project index, every project cursor chain, and shared history.
- Every raw response is content-addressed and atomically written under `source/inventory/` before its IDs enter the union. `inventory.json` and `reports/reconciliation.json` are published only after all enabled chains end through a declared total, cursor exhaustion, recognized empty account, or an empty page where no declared remainder exists.
- The engine merges main/archived/project/shared memberships and listing hashes under `<workspace-fingerprint>/<conversation-id>`, links shared records through `conversation_id`, retains share-only records, and never writes the raw account ID.
- Safety failures include premature empty pages, repeated ordered pages, repeated cursors, offset stalls, invalid envelopes/IDs, page limits, and aggregate byte limits. A failed run leaves its raw evidence available but deliberately does not publish `inventory.json`.
- Commit `bdf4b78` wires the engine into the packaged dashboard. Inventory remains disabled until explicit workspace preflight and directory permission pass; users can include archived, project, and shared scopes, while main history is always required.
- Passed TypeScript checking, 24/24 unit tests, privacy scanning over 41 tracked/unignored files, production build, and packaged Chromium authentication/preflight acceptance. No live account or private conversation data was accessed.
- Next: add explicit multi-workspace orchestration and isolated destinations, then begin batch/detail capture with missing-ID and graph-equivalence checks against the durable inventory.

### 2026-08-01 — Multi-workspace inventory isolation completed

- Commit `271cf72` completes CG-C by changing explicit selection from one workspace to one-or-more workspaces, preflighting every selection, and creating a separate `ChatGPTExport-<workspace-fingerprint>/` archive below the chosen parent directory.
- `runWorkspaceInventories` rejects empty, duplicate, or deactivated target sets and runs every scope independently with the selected raw account ID held only in memory for request headers. Identical provider conversation IDs in two accounts produce distinct logical keys and distinct filesystems.
- The dashboard reports only aggregate workspace-scoped counts and short one-way fingerprints. Tests prove two workspaces with the same conversation ID publish isolated inventories with no logical-key collision.
- Passed TypeScript checking, 25/25 unit tests, privacy scanning over 41 tracked/unignored files, production build, and packaged Chromium multi-select preflight acceptance. Phase CG-C now has implementation and synthetic evidence for every checklist item.
- Next: implement batch-first conversation capture with exact requested/returned ID reconciliation, suspicious batch-graph detection, single-detail recovery, raw revision persistence, journal transitions, completion markers, and crash-safe resume.

### 2026-08-01 — Batch detail reconciliation implemented

- Commit `370c5e5` implements conservative batches of at most ten, exact requested/returned/missing ID evidence, duplicate detection, strict envelope parsing, graph-neighbor/current-node/cycle checks, and single-detail recovery for missing, duplicate, malformed, or suspicious batch records.
- Share-only inventory records bypass the batch endpoint and use their share ID with the dedicated shared-detail adapter. A single-detail or shared-detail graph that remains invalid fails the capture instead of producing a partial success.
- Tests cover a complete batch with no extra requests, all four fallback reasons, shared retrieval, and rejection of an invalid recovery response. TypeScript and 29/29 unit tests pass; no live data was accessed.
- Next: persist batch and detail revisions under each conversation, add durable journal transitions and raw-completion evidence, then make retries resume without trusting partial files.

### 2026-08-01 — Journaled raw capture and deterministic normalization completed

- Commit `7666dba` adds atomic run journals, validated state transitions, content-addressed listing/detail/batch revisions, raw-completion markers, and resume checks that verify identity, listing sets, referenced paths, and byte hashes rather than trusting file presence.
- Commit `6e305fd` preserves every provider graph node and branch, maps known roles and text/multimodal/code/execution/tool/browsing/citation/reasoning/Canvas shapes, retains all raw message and conversation extensions, emits findings for unknown or unsafe structures, and renders deterministic escaped Markdown with the selected branch first and alternatives separately.
- Commit `bb72cf2` composes inventory, batch retrieval, persistence, normalization, Markdown, assets placeholder, metadata, final completion markers, state journals, and capture reports. An unchanged repeat performs zero requests; corrupted derived files rebuild from validated raw bytes; changed listing evidence forces a refetch.
- Commit `d6e1f8c` exposes this workflow in the dashboard across every selected isolated workspace. Capture begins only after complete inventory and reports fetched, rebuilt, unchanged, and failed terminal counts explicitly.
- Passed TypeScript checking, 39/39 unit tests, privacy scanning over 50 tracked/unignored files, production build, and packaged Chromium acceptance. No live account or private conversation data was accessed.
- Next: implement complete asset descriptor extraction and bounded authenticated byte transport, then add content-addressed deduplication, safe signed-URL handling, asset indexes, and partial-asset terminal reporting.

### 2026-08-01 — Loss-aware content, account artifacts, and complete asset scopes implemented

- Commits `5889170`, `2e42477`, and `13cd80e` keep signed download URLs inside the page world, stream bounded opaque byte chunks through the typed bridge, hash incrementally, publish content-addressed files, deduplicate physical bytes, redact URL queries from derived records/errors, and report per-reference failures without hiding successful assets.
- Commits `7490657` and `f432c97` capture sanitized session/workspace metadata, memories, custom instructions, general settings, and beta-feature settings as separate append-preserving account artifacts. A validated artifact marker makes an unchanged repeat perform zero auxiliary requests, while any failed endpoint leaves an explicit partial result.
- Commit `2a1bdd8` preserves completed deep-research results alongside citation/content-reference, browsing, tool/code, Canvas, and unknown provider blocks. Raw message/conversation extensions remain authoritative when a new content shape is not yet understood.
- Commits `49555d5` and `5847295` close the project-file completeness gap: project metadata and files are inventoried from every project-index page, including projects with zero conversations, then downloaded through project-scoped descriptors with their own completion markers. Project and conversation assets share the same content-addressed byte store and global logical-reference index.
- Passed TypeScript checking, 55/55 unit tests across 15 files, privacy scanning over 59 tracked/unignored files, a production build, and packaged Chromium page-local authentication/allowlist acceptance. Signed URL query text is absent from observable extension responses and synthetic tracked fixtures. No live account or private conversation data was accessed.
- Phase CG-D is complete under synthetic evidence. Next: finish explicit dashboard terminal-state UX and the complete deterministic integration matrix, then implement the unified-archive directory adapter and release-quality documentation before live calibration.

### 2026-08-01 — Independent audit, complete dashboard workflow, and unified import implemented

- Commits `7c8e6e1` and `8336cc3` add conservative request delay/concurrency control with cooperative pause/resume/cancel before the next request, plus complete archive enumeration for independent verification. Commit `c4247cb` audits inventory/completion/normalized sets, marker and byte hashes, raw-to-normalized graph traceability, content-addressed assets, temporary-file absence, byte totals, and writes validation reports, `archive.json`, and streaming import indexes.
- Commit `4088a60` exposes workspace/scope state, persisted directory permission, aggregate inventory confirmation, account/artifact and asset scope controls, request pacing, batch size, start/resume/retry, pause/resume/cancel, revalidate-only mode, and distinct complete/assets-partial/incomplete/authentication-required states. The packaged Chromium test now uses an extension-origin directory, proves a paused next request does not start, resumes inventory and two-batch capture, reaches audited completion, and preserves an authoritative tree hash across local revalidation.
- Commit `4c0f8cd` snapshots each prior complete inventory, retains remote-absent conversations separately from the current expected set, and keeps their validated completed records in the import index instead of silently dropping local archive history.
- Commit `400c283` in `/home/travis/Projects/agent_session_migration` adds ChatGPT adapter `1.1.0` for audited ChatGPTExporter directories. It streams `indexes/conversations.jsonl`, verifies contained paths and normalized hashes, preserves graph branches/memberships/citations/provider extensions, registers assets and per-conversation raw provenance, and proves import/version counts `1→0→1` for first, unchanged, and changed content. The dependency-free archive suite passes 59/59 tests with warnings as errors.
- ChatGPTExporter passes 60/60 tests across 17 files, privacy scanning over 63 tracked/unignored files, TypeScript, production build, and packaged browser acceptance at this milestone. No live account or private conversation data was accessed.
- Next: complete the explicit mock integration failure/resume matrix, release documentation, reproducible-package checks, and public repository publication, then begin the authenticated private full-account run.

### 2026-08-01 — Standalone release-quality gate completed and public repository published

- Commits `45c2d5b`, `1773bec`, and `a018565` complete the deterministic test matrix: packaged page-world handling covers sanitized `401`, `403`, `429`, `503`, malformed JSON, oversized response, and timeout states; integration tests prove interruption after raw, derived, completion-marker, and content-addressed asset writes; full-scope capture covers multi-page main, archived duplicates, multiple projects including a file-only project, shared/owned links, batch omission fallback, branches, citation/code/unknown/Canvas/browsing/deep-research/inline media, project files, multiple workspace isolation, an empty workspace, audit, and byte-identical unchanged repeat.
- Commit `927749d` publishes installation, architecture, web-contract, privacy, troubleshooting, and contribution documentation. The Proof skill kept these code-adjacent Markdown files local to the repository rather than creating external document links.
- Commit `f0b2045` removes inherited `storage`, `tabs`, and `unlimitedStorage` grants after packaged acceptance proved the exact ChatGPT host permission is sufficient. Commit `bbb8b4f` prepares version `0.1.0`.
- Final gates pass: TypeScript, 68/68 tests across 19 files, privacy scanning over 71 tracked/unignored files, production build, expanded packaged Chromium workflow, full Git object/path audit, and two deterministic ZIPs with SHA-256 `2e9259cafa4d3de142d872564e9e55d9ab15f102ec4c19629858cd3f7df67937`.
- Created and verified public repository `https://github.com/siraht/ChatGPTExporter`; `main` and `origin/main` matched commit `bbb8b4fe266da5726ca6c9d88953e9412697eaea` before this plan-only follow-up. No live account or private archive data was accessed or published.
- Phase CG-E is complete. Next: load version `0.1.0` in the user's normal signed-in Chromium profile, calibrate one harmless synthetic live conversation, grant a private parent directory, then complete every CG-F inventory/capture/audit/import acceptance gate before consolidation.

### 2026-08-01 — Authenticated live preflight and first provider-drift repair

- Started the private acceptance run in a dedicated, ignored browser profile and completed normal ChatGPT sign-in. The extension found two active accessible workspaces and successfully preflighted both without returning, logging, or persisting access tokens or raw account identifiers.
- Branded Google Chrome 150 silently ignored unpacked-extension command-line loading, so the acceptance browser now uses the locally installed Chrome for Testing with the same dedicated profile. This is an operator/runtime constraint only; the public extension manifest and least-privilege permissions are unchanged.
- Live listing calibration found that conversation pages now encode `create_time` and `update_time` as ISO-8601 strings while conversation details still use numeric epoch seconds. Commit `7b4994e` adds narrow envelope-boundary conversion to epoch seconds and a regression fixture; malformed timestamp strings still fail closed.
- Passed 69/69 tests across 19 files, TypeScript checking, the tracked-file privacy scan over 71 files, and a production build after the repair. No conversation body, title, identifier, account identifier, credential, signed URL, browser state, or private archive artifact was committed or logged.
- Next: grant the native browser directory permission for the private parent directory, inventory both verified workspaces across every enabled scope, review aggregate termination counts, and begin resumable body/asset capture.

### 2026-08-02 — Private full-account capture, audit, transfer, and retrieval accepted

- The selected accessible workspace inventory terminated normally after 15 append-preserved listing pages and contained 938 conversations and two projects. The complete capture has 938/938 completion markers, 743 physical content-addressed assets serving 1,402 logical references, zero partial asset references, zero findings, and zero unresolved conversation failures. The independent audit measured 5,041,241,574 total archive bytes and 982,333,972 asset bytes and reached terminal state `complete`.
- The resumed full run closed at 568 fetched, five rebuilt from preserved raw evidence, 365 unchanged, zero failed, and zero partial asset scopes. The required immediate repeat performed zero fetches and rebuilds, retained all 938 conversations unchanged, and emitted only 938 valid `complete` journal transitions. Background traffic from unrelated restored ChatGPT tabs was observed separately and is not counted as exporter traffic; operation-level evidence proves the exporter issued no repeat fetches.
- Live drift was repaired narrowly in commits `678d22f`, `2bea460`, `086842c`, and `b712ffc`: compact batch timestamps now accept current ISO strings while missing message timestamps remain nullable, and citation-only file references no longer masquerade as downloadable assets. Version `0.1.6` passes TypeScript, 83/83 tests across 19 files, privacy scanning over 72 tracked/unignored files, production build, and packaged Chromium acceptance.
- The reusable private UI sampler in commits `b57f5cb` and `e61a651` compares authenticated DOM title/text anchors in memory and emits category counts only. It sampled every present category: calibration, short, long, old, new, branched, project, shared, cited/browsed, tool/code, uploaded-file, generated-image, Canvas, and deep-research. Archived membership was absent from the verified inventory, so it is explicitly unavailable rather than falsely sampled.
- The audited directory imported locally as 938 candidates and 938 new versions; exact reimport created zero. A private ZIP was snapshotted and transferred to Flywheel as one `web-exports` object, acknowledged twice without retransmission, then imported remotely as 938 candidates and 938 versions; the automated repeat reported 938 candidates, zero new versions, and no index launch.
- Transfer/import drift exposed four archive-control bugs and produced small regression commits in `agent_session_migration`: `965d736` retains the umbrella web-export provider during selective transfer, `7bec6ff` detaches selective snapshot lineage, `742bc81` accepts collection-valued remote results, and `8dd008e` accepts streamed CASS JSON results while raising the measured ingest service ceiling from 8 GiB to 16 GiB. The suite passes 62/62 tests with warnings as errors after these changes.
- Before storage cleanup, the newest recovery set verified with SQLite integrity `ok`. Four exact rebuildable staging targets from earlier recovery, native-import, and CASS work were removed, increasing free space from roughly 16 GiB to 38 GiB without deleting blobs, snapshots, backups, portable records, incoming evidence, acknowledgements, or quarantine. The superseded failed selective batch remains recoverably quarantined.
- Flywheel CASS now reports initialized, healthy, ready, fresh, complete search coverage, zero quarantined conversations, and zero warnings. Sanitized lexical probes for `ChatGPT`, `OpenAI`, `Python`, and `Markdown` returned only `chatgpt-web` hits, and every sampled hit carried logical-conversation and raw provenance.
- Next: commit this aggregate-only record, tag the accepted standalone `0.1.6` revision, reverify the Grok baseline, and begin Phase CG-G consolidation without changing provider behavior.

### 2026-08-02 — Standalone acceptance tagged

- The aggregate-only acceptance record and complete `0.1.6` source are tagged `v0.1.6`; Phase CG-F is complete. No private archive path, account identifier, conversation identifier, title, body, asset name, credential, signed URL, or browser state is present in the tag.
- Next: reverify and tag the accepted Grok baseline, then create the consolidated source tree and port both accepted provider implementations behind compatibility evidence.
