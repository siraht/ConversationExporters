# ChatGPTExporter

ChatGPTExporter is a local, resumable browser extension for archiving the ChatGPT web history available to your signed-in account. It inventories main, archived, project, shared, and explicitly selected workspace scopes before downloading conversation graphs, account artifacts, and referenced files.

Authentication stays inside the normal `chatgpt.com` page. The extension never asks for a token or cookie, has no backend or telemetry, and writes only to a directory you choose.

This is an independent community project and is not affiliated with or endorsed by OpenAI. ChatGPT's private web endpoints can change; retain raw evidence and review the compatibility notes before relying on a new release.

## What it preserves

- Every conversation found by normally terminating main, archived, project, and shared inventory chains.
- Separate histories for every explicitly selected accessible workspace.
- The complete provider graph, including branches and inactive nodes, plus deterministic selected-first Markdown.
- Citations, browsing/tool/code records, Canvas content, completed deep research, unknown future content blocks, and raw provider extensions.
- Uploaded files, generated images, audio, video, inline binaries, research files, and project-level files when ChatGPT permits retrieval.
- Memories, custom instructions, settings, beta-feature settings, and sanitized workspace/session metadata as auxiliary account artifacts.
- Previous local conversations that disappear from a later remote inventory, marked absent rather than deleted.

## Install from source

Requirements are Node.js 20+ and a Chromium browser that supports Manifest V3 and the File System Access API.

```sh
git clone https://github.com/siraht/ChatGPTExporter.git
cd ChatGPTExporter
npm ci
npm run check
npm run test:e2e
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/extension`. Click the extension icon to open its dashboard.

## Export your history

1. Open a normal signed-in `https://chatgpt.com/` tab.
2. In the extension dashboard, find the tab and explicitly select the workspaces to archive.
3. Run preflight, then choose a parent directory. Each workspace receives an isolated `ChatGPTExport-<fingerprint>` directory.
4. Select inventory scopes, build the inventory, review its aggregate counts and termination evidence, and confirm it.
5. Start or resume capture. You can pause before the next request, resume, cancel safely, or rerun to retry incomplete records.
6. Require the final state you need: `complete` means conversations and requested assets passed the independent audit; `conversations complete / assets partial` identifies explicit file exceptions; `incomplete` means the archive is not accepted.
7. Read `reports/validation.md` inside each workspace archive. Use **Revalidate only** to prove local files without contacting ChatGPT.

Do not run multiple exporters against the same account simultaneously. The default 250 ms delay, concurrency 1, and batch size 10 are deliberately conservative.

## Archive and import contract

Raw listing/detail/batch revisions are append-preserving under `source/`. Normalized JSON, Markdown, indexes, and reports are derived and rebuildable. Completion markers are written last and contain hashes of every required conversation artifact.

The audited directory is directly consumable by the unified Agent Session Archive adapter; it does not need a giant synthesized `conversations.json`:

```sh
asm web-import /private/ChatGPTExport-WORKSPACE-FINGERPRINT \
  --provider chatgpt-web --account-label personal --dry-run --json
```

See [Architecture](docs/ARCHITECTURE.md), [web contract](docs/WEB_CONTRACT.md), [privacy model](docs/PRIVACY.md), and [troubleshooting](docs/TROUBLESHOOTING.md) for the operational details.

## Development

```sh
npm test
npm run typecheck
npm run privacy:check
npm run test:e2e
npm run package
```

The project has no runtime dependencies. Playwright, Vitest, TypeScript, and esbuild are development-only. Contributions must use synthetic fixtures and pass the staged privacy scanner; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License and provenance

ChatGPTExporter is MIT licensed. Narrow storage, dashboard, and build primitives were adapted from GrokExporter, and current endpoint/content-shape research was informed by pinned MIT upstream projects. Exact revisions and accepted/rejected ideas are recorded in [UPSTREAM_RESEARCH.md](docs/UPSTREAM_RESEARCH.md).
