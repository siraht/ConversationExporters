# ConversationExporters

ConversationExporters builds one local-first Firefox and Chrome extension for archiving ChatGPT, Claude, Gemini, Google AI Studio, and Grok. It uses the provider session already present in a normal signed-in tab; it never exports cookies, bearer tokens, or provider credentials.

The unified extension keeps its canonical archive in browser IndexedDB, can download that archive as a ZIP, and can replicate changed files to a user-controlled VPS or the optional native host. Chromium users can also write ChatGPT and Grok directly to a selected folder. The original standalone exporters remain buildable for compatibility.

## What each adapter captures

- ChatGPT keeps the mature workspace-aware inventory, archived/project/shared scopes, assets, resume, and archive validation from ChatGPTExporter.
- Grok keeps the mature global/project inventory, assets, resume, and archive validation from GrokExporter.
- Claude captures exposed organizations and conversations, project metadata, instructions and documents, returned raw message trees, uploaded files and generated artifacts. Server-issued next links are followed; bare-array responses cannot independently establish account-wide coverage.
- Gemini exhausts the returned inventory cursors, captures returned conversation candidates and raw payloads, Gems, account metadata, uploads and generated media. A detail turn ceiling is reported as incomplete; undocumented continuation or hidden branches remain subject to live reconciliation.
- Google AI Studio captures authenticated `ListPrompts` and `ResolveDriveResource` requests, exhausts inventory cursors, preserves raw prompt/settings/turn payloads and referenced assets. Opaque provider payloads still require live checks against known prompts.

Provider credentials stay in the provider page. The page bridge returns only the requested conversation data, and the service worker rejects endpoints outside each adapter's allowlist.

## Build and install locally

Node.js 20 or newer is required.

```sh
npm ci
npm run check:unified
npm --workspace conversation-exporter run package
```

The final unpacked builds are in `packages/unified-extension/dist/chrome` and `packages/unified-extension/dist/firefox`. Store-ready ZIPs are written to `packages/unified-extension/dist/releases`.

For Chrome, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `packages/unified-extension/dist/chrome`. For Firefox or Zen, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `packages/unified-extension/dist/firefox/manifest.json`. Firefox temporary installations disappear when the browser restarts; an AMO-signed build installs permanently.

After installing or reloading the extension, refresh signed-in provider tabs. Use **Sync now** beside a provider or **Sync all providers**. All five engines run in the background through one lock; closing the dashboard does not cancel them. Hourly sync uses the same engines. Grant requested media permissions during the first manual sync. AI Studio requires refreshing History and opening one saved prompt to initialize request shapes. Browser shutdown interrupts work; completed records remain available for a later sync.

There is no date cutoff. Equal stored/inventoried counts do not establish universal account coverage. The dashboard shows last-run status and time; archive reports distinguish retrieval and replication failures. Check known oldest, newest, archived and project records during first live acceptance. Only the connected account/session and its exposed scopes can be enumerated; deleted, temporary or inaccessible content cannot be promised. See [the completeness tracker](COMPLETENESS.html) for implemented safeguards, decisions, limitations and pending manual evidence.

IndexedDB works in both browsers with no companion application. The direct-folder buttons appear only where the browser implements the File System Access directory picker, currently Chromium. ZIP creation has a 1 GiB in-browser safety limit; use VPS or native replication for larger browser archives.

## Progress, coverage, and run history

The right sidebar shows all five providers independently: queued, discovery, capture, assets, validation, replication, and finished. Phase labels show observed activity; capture and asset work can overlap. Counts update as the engines report them, without inventing totals or progress percentages during discovery.

Full syncs run up to three providers concurrently. Provider-specific request pacing remains in place to limit throttling and memory use. The dashboard can close while they run. Enable optional completion notifications in the sidebar; the toolbar badge also shows active providers or an attention marker.

Coverage charts show monthly captured, pending, failed, and retained conversations. Click a month to filter the table, or search by title/ID and provider/status. Creation dates are preferred; fallback update dates and unknown dates are labeled. Chart values describe the stored inventory, not independently verified provider-wide coverage.

Manual and scheduled provider sync runs are retained in the browser archive's `run-history` namespace, with phase timestamps, counters and failures. The history view pages through all recorded runs without a deletion cap. History begins with version 0.5.0; earlier missing history is not reconstructed. Combined archive ZIPs include the run records. Coverage metadata refreshes every ten seconds during a run and can be refreshed manually.

## Generic VPS replication

The receiver is a zero-runtime-dependency Node service. It accepts authenticated `PUT` requests, verifies SHA-256 before committing, writes through a private temporary file, and atomically renames into `<root>/live/<provider>/<path>`. The API contains no Flywheel hostname, SSH destination, filesystem root, or rclone remote.

```sh
npm --workspace conversation-archive-receiver run check
export ARCHIVE_RECEIVER_ROOT=/srv/conversation-archive
export ARCHIVE_RECEIVER_TOKEN="$(openssl rand -hex 32)"
export ARCHIVE_RECEIVER_HOST=127.0.0.1
export ARCHIVE_RECEIVER_PORT=8787
npm --workspace conversation-archive-receiver start
```

On a systemd-based VPS, `npm --workspace conversation-archive-receiver run install:user` builds the service, creates a private token file and archive directory, and starts it as a user service. It never configures DNS, a firewall, or TLS; point your preferred HTTPS reverse proxy at the local listener.

Run it as an unprivileged service account and put Caddy, nginx, a tunnel, or a private overlay network in front of `127.0.0.1:8787`. The extension requires HTTPS for a remote receiver; plain HTTP is accepted only for localhost development. A minimal Caddy route is:

```caddyfile
archive.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Enter `https://archive.example.com` and the token in the extension, enable VPS replication, and save. Saving performs an authenticated status request. **Sync changed files** verifies remote hashes before skipping unchanged files, and uploads changed or missing content. The server can run on any Linux VPS, home server, NAS, container host, or machine reachable through Tailscale; only Node, a writable directory, and HTTPS termination are assumed.

rclone remains useful as a second backup layer because the receiver produces ordinary files:

```sh
rclone sync /srv/conversation-archive/live remote:conversation-archive/live
```

## Optional native replication

The native host is useful when a browser archive is too large for a ZIP or an existing local ingestion job expects files. It is optional and is not needed for browser storage or VPS sync.

```sh
npm run build:sync
npm run install:native
```

That installs the Firefox/Zen native manifest, including the unified extension ID. Unified exports become hash-verified snapshots under `${CONVERSATION_SYNC_ROOT:-$HOME/ConversationImports}/outbox`; unchanged objects are reused. Standalone exporters retain their `live` directories. For Chrome, first copy the 32-character extension ID shown on `chrome://extensions`, then reinstall:

```sh
CONVERSATION_CHROME_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop npm run install:native
```

The installer supports Google Chrome, Chromium, and Brave's standard per-user native-host directories. rclone remains a fallback. The old `once --push` / `watch --push` route is disabled because it duplicated local imports and bypassed the VPS indexing worker.

### Automatic SSH delivery to ASM and CASS

The laptop initiates every connection. Requirements: Python 3.11+, a compatible installed ASM runtime, SSH and rsync on both machines, and systemd for timers. No local CASS index or public HTTP endpoint is required.

On the VPS, copy `archive-delivery.py` and `install-delivery.py` from `packages/sync-runner/scripts` to a private tools directory. Run:

```sh
python3 install-delivery.py vps \
  --runtime-src /path/to/asm/src \
  --archive-root /path/to/authoritative-archive --enable
```

The runtime path must contain the `agent_session_archive` package. The installer prints the final helper path. On the laptop, use that path and your SSH alias:

```sh
npm run build:sync
npm run install:native
python3 packages/sync-runner/scripts/install-delivery.py laptop \
  --runtime-src /path/to/asm/src \
  --destination my-vps \
  --archive-root /path/to/authoritative-archive \
  --remote-helper /home/myuser/.local/lib/conversation-exporters/archive-delivery.py \
  --enable
```

Enable **Queue local snapshots for SSH delivery**, save, and approve native messaging. **Sync changed files** queues existing browser archives without fetching providers again. Subsequent provider syncs queue automatically. Keep the account label stable for one login; use a different label before exporting an unrelated account.

The laptop checks every five minutes while awake; VPS ingestion checks every two minutes and semantic catch-up every thirty minutes. VPS user lingering is needed after logout (`loginctl enable-linger USER`, where permitted). Workers share ASM's refresh lock; `--pause-unit maintenance.service` defers work during an existing repair. The laptop service is capped at one CPU/2 GiB, and VPS workers at two CPUs/16 GiB. Verify your host supports user-cgroup limits. Native writes retain 2 GiB free by default (`CONVERSATION_MIN_FREE_BYTES` in the host environment); the server respects ASM's configured disk policy. Originals are never automatically deleted.

The sidebar separates queued, received, imported, searchable and semantic-pending counts. A raw receipt does not mean indexing succeeded. Failed imports retry without another upload. AI Studio's opaque web payloads remain preserved and searchable, with role/branch decoding limitations explicitly recorded.

```sh
# Laptop
systemctl --user status conversation-delivery.timer
journalctl --user -u conversation-delivery.service -n 20
# VPS
systemctl --user status conversation-web-ingest.timer conversation-web-semantic.timer
journalctl --user -u conversation-web-ingest.service -n 20
```

See [the delivery tracker](VPS_INGESTION_PLAN.html) for deployed status and live acceptance. Synthetic integration tests: `ASM_RUNTIME_SRC=/path/to/asm/src python3 packages/sync-runner/tests/test_delivery.py`.

### Browser quota recovery

Version 0.6.0 requests persistent storage and checks a write before fetching providers. The sidebar shows the loaded version, estimated usage/quota and persistence. **Repair storage** retries persistence and the write check without deleting conversations. `unlimitedStorage` can still encounter browser-wide limits ([Mozilla documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local)).

Building files does not update a running temporary extension. Reload Conversation Archive at `about:debugging#/runtime/this-firefox` (Firefox/Zen) or `chrome://extensions` (Chrome), then refresh the dashboard and provider tabs. **Do not remove the extension or clear its data.** If storage stays blocked, replicate the existing archive and report the storage figures. Claude 401/403 errors are separate: confirm account/organization access and resolve any provider challenge before retrying.

## Publish to the Chrome Web Store

1. Register and finish a [Chrome Web Store developer account](https://developer.chrome.com/docs/webstore/set-up-account), including email verification and two-step verification.
2. Run the build and package commands above. Upload `packages/unified-extension/dist/releases/conversation-archive-chrome-0.6.0.zip` as a new item in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole). The ZIP has `manifest.json` at its root and includes 16, 32, 48, and 128 pixel PNG icons.
3. Use `store-screenshot-1280x800.png`, `store-promo-440x280.png`, and the generated `icon-128.png` from `packages/unified-extension/dist/releases` for the listing. Chrome currently requires at least a 1280×800 screenshot and a 440×280 small promotional image.
4. Set the single purpose to: “Create private, portable archives of the user's conversations from supported AI chat websites and copy them only to storage destinations the user chooses.” In the Privacy tab, disclose **personal communications** and **website content**; state that data is stored locally by default, that optional VPS transmission goes only to the exact user-supplied HTTPS origin, and that the developer receives no data.
5. Use this README's **Privacy policy** section as the privacy-policy URL after the repository is public. For reviewer instructions, say to install the extension, sign in to any supported provider in a normal tab, refresh that tab, open the extension dashboard, and run that provider's sync. Explain that VPS and native replication are optional.
6. Choose Public, Unlisted, or Private distribution, complete the listing and support fields, then click **Submit for Review**. The official [publishing guide](https://developer.chrome.com/docs/webstore/publish/) describes the current dashboard flow.

Chrome requires a new, higher manifest version for every update. Do not upload private archives, test profiles, tokens, or provider credentials as source or reviewer material.

## Publish to Firefox Add-ons

1. Run `npx web-ext lint --source-dir packages/unified-extension/dist/firefox`; the release is expected to report zero errors, warnings, and notices.
2. Log in to the [AMO Developer Hub](https://addons.mozilla.org/developers/), choose **Submit a New Add-on**, and choose either **On this site** for a public AMO listing or **On your own** for Mozilla signing without a listing.
3. Upload `packages/unified-extension/dist/releases/conversation-archive-firefox-0.6.0.zip`. Manifest V3 signing uses the stable Firefox ID already in the manifest. The manifest declares no transmission by default and requests Firefox's optional personal-communications and website-content consent when the user enables VPS or native replication.
4. Because the release JavaScript is bundled from TypeScript, upload `packages/unified-extension/dist/releases/conversation-archive-source-0.6.0.zip` when AMO asks for generated-source material. A clean checkout plus `npm ci && npm run build:unified` is the reproducible build procedure; the source packager runs the privacy gate and excludes ignored build output, private exports, and browser profiles.
5. Fill in the listing, privacy-policy URL, support address, categories, and reviewer notes, then submit. Mozilla's current [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/) covers both listed and self-distributed signing. Download the signed XPI from AMO; that signed XPI, rather than the unsigned source ZIP, is the permanent Firefox/Zen install.

## Suggested store copy

**Short description:** Completely archive and incrementally sync your signed-in ChatGPT, Claude, Gemini, AI Studio, and Grok histories.

**Detailed description:** Conversation Archive creates complete, private, portable copies of histories already available in your signed-in AI chat tabs. All five providers have resumable, provider-specific exporters that preserve raw records, account/project objects, referenced assets, and explicit validation instead of silently treating partial output as complete. Archives stay in browser storage by default and can be downloaded as a ZIP. Optional replication sends changed files only to a VPS endpoint you configure or to a local native host. There is no telemetry, advertising, developer-operated backend, or credential-export workflow.

## Privacy policy

Effective August 12, 2026.

Conversation Archive handles conversation text, attachments, titles, timestamps, project/workspace metadata, and related website response content solely to create the archive the user requests. It processes this data locally in the browser and stores it in extension IndexedDB or a folder the user selects. Provider cookies, authorization headers, and session tokens remain inside the signed-in provider page and are never written to an archive.

The extension has no telemetry, analytics, advertising, tracking, developer-operated data service, or remote code. The developer does not receive, sell, share, or use archive data. If the user explicitly enables VPS replication, the extension sends archive file bodies and a bearer credential only to the HTTPS origin the user entered. If the user enables native replication, data goes only to the native program on that same computer. Those user-controlled destinations have their own security and retention properties.

Local browser data remains until the user removes the extension or deletes its browser data. Direct-folder, native-host, downloaded ZIP, and VPS copies remain until the user deletes them from those destinations. Users can stop further transmission at any time by disabling VPS or native replication in the dashboard.

Use of information received from provider APIs and websites is limited to providing the user-facing archive and portability features described here. The data is never used for personalized advertising, credit decisions, profiling, or human review by the developer. This use complies with the Chrome Web Store User Data Policy's Limited Use requirements. Security reports and privacy questions can be filed through the repository's GitHub issue tracker without attaching conversation data, credentials, or private archives.

## Packages and compatibility

- `packages/unified-extension` builds the Firefox and Chrome extension plus release ZIPs and listing images.
- `packages/vps-receiver` is the generic authenticated file receiver.
- `packages/shared` contains provider-neutral storage, hashing, filesystem, dashboard, relay, and boundary primitives.
- `packages/grok-exporter` and `packages/chatgpt-exporter` retain the accepted standalone engines and archive formats.
- `packages/web-sync-exporter` contains the Claude, Gemini, and Google AI Studio page adapters.
- `packages/sync-runner` contains optional native-host, rclone, Drive, SSH, and archive-index reconciliation.

Existing standalone archives remain compatible. Direct-folder mode can resume in existing ChatGPT/Grok archive directories; browser archives use the same provider schemas under provider-specific namespaces. See [PROVENANCE.md](PROVENANCE.md) for accepted source revisions and upstream provenance.

ConversationExporters is MIT licensed. Private exports, browser profiles, credentials, signed URLs, and personal conversation data do not belong in this repository.
