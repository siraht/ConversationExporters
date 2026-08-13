# ConversationExporters

ConversationExporters builds one local-first Firefox and Chrome extension for archiving ChatGPT, Claude, Gemini, Google AI Studio, and Grok. It uses the provider session already present in a normal signed-in tab; it never exports cookies, bearer tokens, or provider credentials.

The unified extension keeps its canonical archive in browser IndexedDB, can download that archive as a ZIP, and can replicate changed files to a user-controlled VPS or the optional native host. Chromium users can also write ChatGPT and Grok directly to a selected folder. The original standalone exporters remain buildable for compatibility.

## What each adapter captures

- ChatGPT keeps the mature workspace-aware inventory, archived/project/shared scopes, assets, resume, and archive validation from ChatGPTExporter.
- Grok keeps the mature global/project inventory, assets, resume, and archive validation from GrokExporter.
- Claude incrementally lists and reads conversations through Claude's authenticated web API.
- Gemini incrementally lists and reads chats through Gemini's authenticated page RPCs, with rendered extraction retained as a fallback in the underlying adapter.
- Google AI Studio captures the authenticated `ListPrompts` request made by the page, paginates it without exposing its opaque session fields, and stores each complete provider response losslessly with a stable ID and content hash.

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

After installing or reloading the extension, refresh any signed-in provider tabs so their page bridges are current. Click the extension icon to open the unified dashboard. ChatGPT and Grok have their full exporter dashboards; Claude, Gemini, and AI Studio sync directly from the unified page. AI Studio must make one prompt-history request after the extension loads, so open its saved prompt/history view and refresh it before the first sync.

IndexedDB works in both browsers with no companion application. The direct-folder buttons appear only where the browser implements the File System Access directory picker, currently Chromium. ZIP creation has a 1 GiB in-browser safety limit; use VPS or native replication for larger browser archives.

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

Run it as an unprivileged service account and put Caddy, nginx, a tunnel, or a private overlay network in front of `127.0.0.1:8787`. The extension requires HTTPS for a remote receiver; plain HTTP is accepted only for localhost development. A minimal Caddy route is:

```caddyfile
archive.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Enter `https://archive.example.com` and the token in the extension, enable VPS replication, and save. Saving performs an authenticated status request, and **Sync changed files now** uploads only content whose local SHA-256 changed. The server can run on any Linux VPS, home server, NAS, container host, or machine reachable through Tailscale; only Node, a writable directory, and HTTPS termination are assumed.

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

That installs the Firefox/Zen native manifest and writes to `${CONVERSATION_SYNC_ROOT:-$HOME/ConversationImports}/live`. For Chrome, first copy the 32-character extension ID shown on `chrome://extensions`, then reinstall:

```sh
CONVERSATION_CHROME_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop npm run install:native
```

The installer supports Google Chrome, Chromium, and Brave's standard per-user native-host directories. rclone and the older SSH/ASM reconciliation pipeline remain in `packages/sync-runner`, but their Flywheel defaults are legacy personal configuration rather than requirements of the extension or VPS receiver.

## Publish to the Chrome Web Store

1. Register and finish a [Chrome Web Store developer account](https://developer.chrome.com/docs/webstore/set-up-account), including email verification and two-step verification.
2. Run the build and package commands above. Upload `packages/unified-extension/dist/releases/conversation-archive-chrome-0.2.0.zip` as a new item in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole). The ZIP has `manifest.json` at its root and includes 16, 32, 48, and 128 pixel PNG icons.
3. Use `store-screenshot-1280x800.png`, `store-promo-440x280.png`, and the generated `icon-128.png` from `packages/unified-extension/dist/releases` for the listing. Chrome currently requires at least a 1280×800 screenshot and a 440×280 small promotional image.
4. Set the single purpose to: “Create private, portable archives of the user's conversations from supported AI chat websites and copy them only to storage destinations the user chooses.” In the Privacy tab, disclose **personal communications** and **website content**; state that data is stored locally by default, that optional VPS transmission goes only to the exact user-supplied HTTPS origin, and that the developer receives no data.
5. Use this README's **Privacy policy** section as the privacy-policy URL after the repository is public. For reviewer instructions, say to install the extension, sign in to any supported provider in a normal tab, refresh that tab, open the extension dashboard, and run that provider's sync. Explain that VPS and native replication are optional.
6. Choose Public, Unlisted, or Private distribution, complete the listing and support fields, then click **Submit for Review**. The official [publishing guide](https://developer.chrome.com/docs/webstore/publish/) describes the current dashboard flow.

Chrome requires a new, higher manifest version for every update. Do not upload private archives, test profiles, tokens, or provider credentials as source or reviewer material.

## Publish to Firefox Add-ons

1. Run `npx web-ext lint --source-dir packages/unified-extension/dist/firefox`; the release is expected to report zero errors, warnings, and notices.
2. Log in to the [AMO Developer Hub](https://addons.mozilla.org/developers/), choose **Submit a New Add-on**, and choose either **On this site** for a public AMO listing or **On your own** for Mozilla signing without a listing.
3. Upload `packages/unified-extension/dist/releases/conversation-archive-firefox-0.2.0.zip`. Manifest V3 signing uses the stable Firefox ID already in the manifest. The manifest declares no transmission by default and requests Firefox's optional personal-communications and website-content consent only when the user enables VPS replication.
4. Because the release JavaScript is bundled from TypeScript, upload `packages/unified-extension/dist/releases/conversation-archive-source-0.2.0.zip` when AMO asks for generated-source material. A clean checkout plus `npm ci && npm run build:unified` is the reproducible build procedure; the source packager runs the privacy gate and excludes ignored build output, private exports, and browser profiles.
5. Fill in the listing, privacy-policy URL, support address, categories, and reviewer notes, then submit. Mozilla's current [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/) covers both listed and self-distributed signing. Download the signed XPI from AMO; that signed XPI, rather than the unsigned source ZIP, is the permanent Firefox/Zen install.

## Suggested store copy

**Short description:** Archive and incrementally sync your signed-in ChatGPT, Claude, Gemini, AI Studio, and Grok conversations.

**Detailed description:** Conversation Archive creates private, portable copies of conversations already available in your signed-in AI chat tabs. It supports resumable ChatGPT and Grok exports, incremental Claude and Gemini sync, and lossless Google AI Studio saved-prompt capture. Archives stay in browser storage by default and can be downloaded as a ZIP. Optional replication sends changed files only to a VPS endpoint you configure or to a local native host. There is no telemetry, advertising, developer-operated backend, or credential-export workflow.

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
