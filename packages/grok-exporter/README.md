# GrokExporter

GrokExporter is a privacy-first Chromium extension for making a complete, resumable, and verifiable local archive of your Grok web conversation history.

The exporter runs in your normal authenticated `grok.com` tab. It never reads or stores your cookies, sends no conversation data to a backend, and writes raw source payloads, normalized JSON, Markdown, and assets directly to a directory you choose.

> [!WARNING]
> GrokExporter uses private endpoints used by Grok's own web interface. They can change without notice. Export only accounts you are authorized to access, use conservative request settings, and retain xAI's official account export as an independent backup.

## Project status

The extension implements complete token pagination across global and project-scoped history, response-graph capture, resumable per-conversation output, workspace/project metadata, current Grok citation fields, content-hashed asset downloads, and explicit validation.

The release candidate passed a private full-account acceptance run on 2026-07-20. Only aggregate evidence is public: 19 pages across four exhausted token chains—the global history and three project scopes—produced 946 unique conversations, 946 valid completion markers, zero conversation failures, zero asset failures, and a second mixed resume run that recaptured eight newly linked project conversations while leaving 938 unchanged.

See [installation and use](docs/INSTALLATION.md), [architecture](docs/ARCHITECTURE.md), [privacy](docs/PRIVACY.md), and [troubleshooting](docs/TROUBLESHOOTING.md). The acceptance criteria, decisions, and progress remain tracked in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); upstream research and exact reviewed revisions are recorded in [docs/UPSTREAM_RESEARCH.md](docs/UPSTREAM_RESEARCH.md).

## Design promises

- Complete token-based history enumeration rather than a single large request.
- Project/workspace scopes are inventoried separately and merged, because Grok's global list can omit membership metadata.
- Raw-first preservation, with normalized JSON and Markdown as reproducible derived artifacts.
- Per-conversation checkpoints and atomic output so interrupted runs can resume.
- Explicit validation: a partial archive cannot report itself as complete.
- No runtime analytics, remote scripts, cookie extraction, or required server.
- Synthetic fixtures only in the public repository; real exports remain local and ignored.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run check
npm run test:e2e
```

The unpacked extension will be emitted under `dist/extension/`. Release packaging will produce a deterministic archive under `dist/releases/`.

## License and attribution

GrokExporter is MIT licensed. It is an independent implementation informed by several open-source exporters; see [docs/UPSTREAM_RESEARCH.md](docs/UPSTREAM_RESEARCH.md) for provenance and licensing boundaries.
