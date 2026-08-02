# Upstream research and provenance

Reviewed on 2026-07-20. Repositories were shallow-cloned into the ignored `research/repos/` directory. The revisions below make the analysis reproducible without vendoring upstream source into GrokExporter.

## Revision and license inventory

| Project | Reviewed revision | License | Intended use |
|---|---|---|---|
| `llg1634/grok-full-exporter` | `2f18ed24c1e37dcec682fefbb8101c25caf88f9f` | MIT | Behavioral and endpoint reference; selectively adapt small utilities with attribution if needed. |
| `communism420/All-Chats-Sidebar-for-Grok` | `34ab83238406e97f1860de33d58de772b5e7b0a7` | MIT | Primary reference for conversation pagination and the two-world extension bridge. |
| `dotCipher/ai-vault` | `3dde18d2fe1fe6fa14ab00a190a623f42b2e8151` | MIT | Reference for workspace, project, asset, media-recovery, and incremental concepts. |
| `MattTheCoder556/ChatArchiver` | `96e07000d55f1bc86f589a9ec2b7b92fe68793c0` | No license file | Behavioral observation only; no source may be copied or adapted. |
| `revivalstack/ai-chat-exporter` | `4ce218d1290956703489870aafa2adfdf4448f38` | MIT | Markdown rendering comparison and manual single-chat fallback reference. |
| `iikoshteruu/enhanced-grok-export` | `ec78ebb4e4a5c35f49bf3ab500573f349f23b075` | MIT | Historical X-hosted Grok DOM compatibility reference only. |

## Observed Grok web contracts

These are private web-application endpoints, not a public xAI API. Every adapter must tolerate drift, preserve unexpected envelopes, and fail visibly when its completeness assumptions no longer hold.

### Conversation inventory

The strongest current contract is:

```http
GET /rest/app-chat/conversations?pageSize=100
GET /rest/app-chat/conversations?pageSize=100&pageToken=<opaque-token>
Accept: application/json
```

Observed list fields can appear at `conversations`, `result.conversations`, `data.conversations`, or `items`. The next token can appear at `nextPageToken`, `result.nextPageToken`, `data.nextPageToken`, or `next_page_token`.

`All-Chats-Sidebar-for-Grok` follows this contract and continues for up to 50 pages per load. GrokExporter will remove the arbitrary account-size ceiling while retaining configurable safety limits, token-cycle detection, duplicate-ID detection, and a maximum aggregate response-byte budget.

`grok-full-exporter` instead sends `limit`, sometimes `cursor` and `pageToken` together, and an offset fallback. The server may currently tolerate this, but it is weaker than using the exact request made by the active Grok sidebar implementation.

### Conversation capture

The most complete observed sequence is:

```http
GET /rest/app-chat/conversations/<id>
GET /rest/app-chat/conversations/<id>/response-node?includeThreads=true
POST /rest/app-chat/conversations/<id>/load-responses
Content-Type: application/json

{"responseIds":["..."]}
```

`load-responses` may return `responses` directly or under common `data`, `result`, or `items` envelopes. Some implementations also inspect `nextCursor`, `cursor`, `nextPageToken`, `next`, `hasMore`, or `hasNextPage`. GrokExporter will batch response IDs, follow response-level cursors when present, and prove that the returned ID set matches the response-node set.

Using the `/responses` shortcut observed in ChatArchiver is rejected because the response-node plus load-responses sequence has more independent corroboration and exposes branch structure.

### Assets and hierarchy

`ai-vault` currently probes:

```http
GET /rest/assets?pageSize=<n>&orderBy=ORDER_BY_LAST_USE_TIME
GET /rest/assets/<asset-id>
GET /rest/workspaces?pageSize=<n>&orderBy=ORDER_BY_LAST_USE_TIME
GET /rest/workspaces/<workspace-id>/projects
```

Its list functions do not follow pagination tokens, so they are endpoint-discovery references rather than completeness implementations. It also resolves some expired asset URLs by retrieving an asset record and constructing `https://assets.grok.com/<key>`.

Live verification against Grok's 2026-07-20 frontend found that the nested `/projects` route now returns `404`. The current frontend models UI projects as workspace records and uses these contracts:

```http
GET /rest/workspaces/<workspace-id>
GET /rest/app-chat/conversations?pageSize=<n>&pageToken=<token>&workspaceId=<workspace-id>
```

The global conversation list can contain the same chats with an empty `workspaces` array, so GrokExporter treats every workspace-scoped token chain as part of inventory completeness, merges duplicate IDs, and retains the discovered membership. Asset and workspace adapters remain allowlisted, paginated, raw-preserving, and explicitly validated.

## Ideas accepted into GrokExporter

- A `MAIN`-world script performs authenticated same-origin requests, while an isolated extension script relays typed commands. This pattern is already deployed by `All-Chats-Sidebar-for-Grok` without requesting cookie permission.
- Inventory uses `pageSize` plus the opaque `pageToken`, and a run is incomplete until the token chain ends normally.
- Response nodes are captured separately from response bodies so regenerated branches and missing bodies remain detectable.
- Every conversation retains raw listing, metadata, node, and response-batch payloads alongside normalized output.
- Incremental decisions use remote modification metadata plus local content hashes, while failures remain absent from completion state and are retried later.
- Grok media downloads are sequential or minimally concurrent, and a failed direct URL can optionally be resolved through its asset identifier.
- Synthetic browser fixtures and deterministic release packaging are preferable to testing against a real account in CI.

## Ideas rejected or changed

- **Cookie export or a persistent Playwright profile:** this expands the secret surface and creates Cloudflare/session-maintenance work. The normal logged-in browser is the acquisition boundary.
- **DOM as the primary source:** virtualized history, lazy rendering, hidden branches, and heuristic speaker detection cannot provide an archival completeness proof.
- **Alternating unknown roles:** an unknown sender remains `unknown` with a normalization warning; ordering does not prove authorship.
- **One giant in-memory ZIP:** a late failure loses the entire run and memory grows with the archive. Direct directory writes and per-conversation completion markers provide bounded recovery.
- **A large single list request:** `pageSize=1000` still imposes a silent ceiling. Only token exhaustion proves list completion.
- **Ignoring asset failures:** text completion and asset completion are separate validation dimensions.
- **Deleting local conversations absent remotely:** remote deletion becomes an inventory event, never an instruction to destroy the archive.

## Attribution policy

GrokExporter is an independent implementation under the MIT License. When code is copied or substantially adapted from an MIT project, the affected source file will identify the upstream project, revision, license, and relevant original file. General endpoint behavior, architecture, and interoperability facts are recorded here for provenance but do not require copied implementation.
