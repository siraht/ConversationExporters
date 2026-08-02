# ConversationExporters

ConversationExporters is the shared source tree for two independently accepted, privacy-first Chromium extensions:

- GrokExporter inventories and downloads the complete Grok web history exposed to the signed-in user.
- ChatGPTExporter inventories and downloads the complete ChatGPT web history exposed by the selected accessible workspace and scope set.

Both extensions run against a normal signed-in browser tab and write directly to a directory you choose. There is no exporter backend, telemetry, cookie extraction, or token-copying workflow.

The repository shares only behavior proven equivalent by the standalone releases. Provider authentication, endpoint construction, pagination, envelope parsing, normalization, asset rules, and host permissions remain provider-owned. Builds produce two separate Manifest V3 extensions, so installing either exporter grants no access to the other provider.

## Packages

- `packages/shared` contains provider-neutral JSON, hashing, filesystem, dashboard, relay, and capability-contract primitives.
- `packages/grok-exporter` descends from accepted GrokExporter `v0.1.0`.
- `packages/chatgpt-exporter` descends from accepted ChatGPTExporter `v0.1.6`.

## Build and install

Node.js 20 or newer is required.

```sh
npm ci
npm run check
npm run test:e2e
npm run release:verify
```

Build both extensions with `npm run build`, or one with `npm run build:grok` or `npm run build:chatgpt`. Load the desired package's `dist/extension` directory from `chrome://extensions` after enabling Developer mode. Do not load the repository root as an extension.

`npm run package:grok` and `npm run package:chatgpt` produce separate ZIPs under their package-local `dist/releases` directories. `npm run release:verify` builds each twice, requires byte-identical ZIPs, and fails if its accepted manifest identity, version, or host-permission set changes.

## Provider boundaries

GrokExporter retains token-based global and project/workspace enumeration, Grok envelopes, Grok/X asset hosts, and schema-v1 archive compatibility. ChatGPTExporter retains page-local ephemeral authentication, mixed offset/cursor inventory across main, archived, project, shared, and selected-workspace scopes, graph-aware normalization, and ChatGPT asset sessions.

The shared provider contract gives orchestration code a common vocabulary while leaving each provider's cursor and raw evidence types opaque. Shared runtime code accepts operation descriptors; provider packages still validate and construct every network endpoint.

## Upgrading from a standalone repository

Existing archives stay where they are. Build the matching package here, replace the unpacked extension with that package's `dist/extension`, choose the same archive parent when you want to resume, and use the provider dashboard's normal revalidation/resume controls. The consolidation does not rewrite raw evidence, change archive schemas, or require copying private data into this repository.

The standalone tags remain immutable compatibility baselines. GrokExporter `v0.1.0` maps to `packages/grok-exporter`; ChatGPTExporter `v0.1.6` maps to `packages/chatgpt-exporter`. Future fixes should land here and increment only the affected provider's manifest/package version unless shared behavior changes both outputs.

## Verification and privacy

The inherited standalone synthetic suites remain intact and their accepted authoritative archive hashes are pinned after the shared extraction. The full gate covers 11 shared-contract tests, 31 Grok tests, 84 ChatGPT tests, both packaged Chromium extensions, privacy scans, manifest boundaries, and reproducible release ZIPs. Private acceptance is recorded only as aggregate evidence in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

Private exports, browser profiles, credentials, signed URLs, and personal conversation data do not belong in this repository.

## License and provenance

ConversationExporters is MIT licensed. See [PROVENANCE.md](PROVENANCE.md) for the accepted source revisions, extraction rules, and upstream research locations.
