# Privacy

GrokExporter processes conversations entirely on the user's machine. It has no analytics, telemetry, update server, remote JavaScript, account system, or project-operated backend.

## Permissions

- `https://grok.com/*` lets the extension install the authenticated bridge and access Grok's private web endpoints.
- The media-host permissions cover currently observed Grok/X asset delivery hosts: `assets.grok.com`, `imagine-public.x.ai`, `pbs.twimg.com`, and `video.twimg.com`.
- `tabs` finds an already-open Grok tab; it does not inspect unrelated page contents.
- `storage` and `unlimitedStorage` preserve the selected directory handle and small extension state.
- The File System Access API grants access only to the directory the user explicitly selects.

The extension never requests Chrome's cookie permission and never reads or stores Grok session cookies or authorization headers.

## Public-repository safeguards

Real exports, browser profiles, HAR captures, ZIP archives, credentials, local upstream checkouts, and private directories are ignored. A repository-owned pre-commit hook scans staged files for these paths and common credential forms. CI repeats the scan across every tracked or unignored file.

Enable the hook after cloning:

```bash
git config core.hooksPath .githooks
```

The scanner is defense in depth, not a substitute for reviewing `git diff --cached` before publishing.

