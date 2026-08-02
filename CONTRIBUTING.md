# Contributing

Contributions should preserve completeness, resumability, least privilege, and the private-data boundary. A shorter exporter that silently caps history or drops unknown provider shapes is a regression.

## Before changing code

- Read `IMPLEMENTATION_PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WEB_CONTRACT.md`, and `docs/PRIVACY.md`.
- Keep runtime dependencies at zero unless a dependency is demonstrably easier to maintain than the equivalent small implementation.
- Keep provider endpoint semantics in `src/chatgpt/`; generic deterministic storage and validation belong in `src/core/` only after both uses are proven.
- Use exact read-only operations. Never add arbitrary fetch, caller-controlled headers, cookie access, or provider mutation endpoints.

## Tests and fixtures

Use synthetic fixtures only. Add a focused test beside each endpoint, parser, graph/content shape, failure, resume transition, or security boundary you change.

```sh
npm ci
npm run check
npm run test:e2e
npm run package
```

Run packaging twice and compare SHA-256 before proposing a release. Manually review `public/manifest.json` for permission expansion.

## Privacy review

Never copy a personal request/response into a fixture, commit an archive/export/HAR/browser profile, or paste credentials into a test. Before committing:

```sh
git status --short
git diff --check
npm run privacy:check
git diff --cached
```

The staged scanner runs from the pre-commit hook. Treat a scanner pass as a minimum gate; you still own the staged-content review.

## Commits and pull requests

Use small Conventional Commits such as `feat(chatgpt):`, `fix(core):`, `test(extension):`, or `docs:`. Explain the provider evidence, completeness effect, failure behavior, tests run, and any manifest/endpoint change. Keep private live-calibration evidence uncommitted; publish only sanitized aggregate results.
