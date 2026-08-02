# Privacy and security model

ChatGPTExporter is designed for private local archives. It has no server component, telemetry, analytics, remote logging, update beacon, or cloud storage integration. Provider requests go from your signed-in ChatGPT page to ChatGPT; archive writes go from the extension dashboard to the directory you explicitly grant.

## Data that must remain private

Archive directories contain conversation bodies, titles, account settings, memories, custom instructions, file names, provider IDs, and downloaded assets. Treat the entire `ChatGPTExport-*` tree as sensitive. Do not place it inside this source checkout, attach it to an issue, commit it, or publish validation findings without reviewing them.

Workspace labels and raw account IDs are visible transiently during explicit selection. Only a truncated SHA-256-derived fingerprint appears in directory names and aggregate dashboard progress. Raw account IDs, email addresses, session tokens, cookies, signed URLs, and browser profiles must never enter source control or derived public reports.

## Authentication boundary

The access token stays in a closure in the `MAIN` world of the existing ChatGPT tab. The page bridge uses it for exact allowlisted operations, then returns only sanitized response data. Signed asset URLs follow the same rule: page world owns the URL and other contexts see an opaque handle plus bounded bytes.

This reduces accidental exposure; it does not make a malicious extension safe. Install only code you have reviewed, keep Chromium and the extension source under your control, and remove the unpacked extension when you no longer need it.

## Repository safeguards

The repository ignores captures, exports, archives, browser profiles, HAR files, credentials, environment overrides, build products, and research checkouts. A pre-commit privacy scanner rejects common token/cookie headers, JWT-like values, high-entropy secrets, response-envelope patterns, and private-export paths. Synthetic fixtures use obvious non-secret values and must contain no copied personal text.

The scanner is defense in depth, not permission to stage private artifacts. Review `git status`, staged diffs, and the final tracked tree before every public push.

## Local retention

The exporter never deletes remote conversations, remote files, or local archive evidence. A conversation missing from a later inventory is retained locally and marked absent. Remove or back up archive directories only through your normal private-data process; source-code uninstall does not remove them.
