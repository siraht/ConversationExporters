# Contributing

Use Node.js 20 or newer. Install dependencies, enable the privacy hook, and run the full check before committing:

```bash
npm install
git config core.hooksPath .githooks
npm run check
npm run test:e2e
```

Keep commits focused. Endpoint compatibility changes require synthetic fixtures, an explanation in `docs/UPSTREAM_RESEARCH.md`, and a plan/journal update when they change an architectural decision.

Never commit real Grok data, HAR files, browser profiles, cookies, authorization headers, signed URLs, or screenshots containing conversations. Bug reports should use fabricated IDs and payloads that retain only the structural fields needed to reproduce the problem.

Copied or substantially adapted MIT source needs file-level attribution with the upstream project, revision, original file, and license. Source without a license is behavioral reference only.

