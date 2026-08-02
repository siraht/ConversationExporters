# ConversationExporters consolidation plan

Status: release candidate; repaired remote CI rerun pending

Goal: consolidate the accepted GrokExporter and ChatGPTExporter implementations into one maintainable source tree while preserving complete private archives, provider-specific web semantics, least-privilege manifests, deterministic output, and independent releases.

The complete standalone research, implementation history, decisions, and acceptance criteria remain in `packages/grok-exporter/IMPLEMENTATION_PLAN.md` and `packages/chatgpt-exporter/IMPLEMENTATION_PLAN.md`. This file is the authoritative Phase CG-G completion record. Private identifiers, titles, content, archive locations, credentials, signed URLs, and browser state must never be recorded here.

## Completion checklist

- [x] Tag and reverify the accepted Grok `v0.1.0` and ChatGPT `v0.1.6` baselines.
- [x] Import both accepted revisions into one workspace-based repository without changing their manifests or synthetic fixture suites.
- [x] Extract proven-equivalent JSON, hashing, serialization, path, filesystem, directory-handle, dashboard, relay, and service-worker primitives.
- [x] Define a capability-oriented provider contract with provider-owned account, scope, cursor, raw-envelope, normalized, asset, and validation types.
- [x] Keep Grok and ChatGPT endpoint construction, authentication, pagination, envelopes, normalization, assets, dashboards, and manifests in provider packages.
- [x] Pin accepted standalone synthetic archive hashes after extraction and pass both inherited full suites.
- [x] Produce separate Grok-only and ChatGPT-only manifests and reproducible ZIP releases with no host-permission expansion.
- [x] Revalidate both private archives from the consolidated tree using aggregate-only evidence.
- [x] Add root privacy scanning, provenance, upgrade instructions, CI, packaged Chromium tests, and deterministic release verification.
- [ ] Run the final clean-checkout gate, publish the public repository, tag `v0.1.0`, and confirm the remote refs.

## Evidence

- Shared core: 11 tests across six files pass, including provider cursor opacity, runtime sender validation, same-origin page relay behavior, dashboard compatibility, filesystem semantics, and manifest boundaries.
- Grok: 31 tests across nine files, TypeScript, build, privacy scan, and packaged Chromium bridge pass. The inherited synthetic archive produces the same authoritative hash as standalone `v0.1.0`.
- ChatGPT: 84 tests across 20 files, TypeScript, build, privacy scan, and packaged Chromium dashboard/directory/archive-tree acceptance pass. The inherited full-scope synthetic archive produces the same authoritative hash as standalone `v0.1.6`.
- Release isolation: the imported public manifests remain byte-identical to their standalone baselines. Grok requests only its accepted Grok/X hosts; ChatGPT requests only `chatgpt.com`. Two consecutive packages for each provider are byte-identical.
- Grok private archive: all 946 inventory, directory, index, validation, and completion-marker members reconcile; 107/107 complete assets match size and SHA-256; there are zero normalized-hash mismatches, invalid validations, missing raw paths, asset mismatches, or report failures.
- ChatGPT private archive: all 14 available live-UI content categories pass aggregate-only sampling from the consolidated script. The archive remains 938/938 conversations complete with zero unresolved conversation or asset findings; archived membership is explicitly absent rather than counted as a pass.
- Unified archive: the accepted ChatGPT corpus previously imported 938 versions and created zero new versions on exact repeat. Flywheel reports healthy, fresh, complete search coverage with raw and logical provenance; consolidation does not change that archive contract.

## Decisions

- One source tree emits two extensions. Sharing implementation does not justify cross-provider permissions.
- Provider cursors remain opaque. A shared async page contract can carry Grok tokens and ChatGPT offset/cursor evidence without pretending they are interchangeable.
- Raw archive schemas remain stable. Shared schema evolution accepts versioned provider identifiers, but existing Grok schema-v1 and ChatGPT schema-v1 evidence is read without rewriting it.
- The accepted standalone tags are immutable regression anchors. Synthetic corpus hashes, manifest bytes, private aggregate revalidation, and packaged tests are the extraction proof.
- Dependencies stay development-only and limited to TypeScript, esbuild, Vitest, Playwright, and deterministic ZIP creation because each replaces substantial cross-platform build/test work without entering the extension runtime.

## Progress journal

### 2026-08-02 — accepted baselines imported

- Created the workspace repository, imported the tagged provider histories as subtrees, and established root ignore/privacy/provenance boundaries before extraction.
- Preserved both standalone manifests and provider packages, then passed their unchanged test suites in the consolidated dependency graph.

### 2026-08-02 — shared seams extracted under compatibility tests

- Extracted only byte-equivalent or behaviorally proven core, filesystem, dashboard, and extension-runtime helpers. Provider descriptors centralize identity/origin/source-URL construction while provider modules retain web contracts.
- Added a generic capability contract whose cursor and evidence parameters remain provider-owned. Added focused runtime, relay, dashboard, permission-boundary, and schema-v1 compatibility tests.

### 2026-08-02 — release and private acceptance complete

- Pinned authoritative synthetic archive hashes obtained from the accepted standalone revisions; both consolidated outputs match.
- Verified separate deterministic release ZIPs, exact accepted permission boundaries, and both packaged Chromium extensions.
- Revalidated both private archives without emitting private paths or content. Added a reusable aggregate-only Grok archive auditor and reran the aggregate-only ChatGPT live-UI sampler.
- Added CI, release verification, provenance, upgrade instructions, and this final checklist.

### 2026-08-02 — public consolidation released

- A detached clean worktree passed fresh `npm ci`, all 126 tests, both TypeScript/build/privacy gates, both packaged Chromium tests, and reproducible independent release packaging.
- Published the public `siraht/ConversationExporters` repository and confirmed its `main` ref. The tag-triggered CI passed, but its simultaneous branch run exposed a wall-clock race in the packaged ChatGPT pause test: the synthetic response could complete before the click arrived on a loaded runner.
- Replaced the 75 ms timing assumption with an explicit fixture response gate that holds the active request until the dashboard is observably paused. Five consecutive packaged runs pass locally; the final checkbox remains open until the repaired commit passes remote CI and receives the release tag.
