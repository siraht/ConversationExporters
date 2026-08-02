# Troubleshooting and API drift

## No Grok tab found

Open `https://grok.com`, sign in, reload the tab after installing or updating GrokExporter, and start the export again. The content bridge is installed when the page loads.

## HTTP 401 or 403

Reload Grok and confirm the conversation history works normally. A `403` for a media file can mean a signed URL expired; GrokExporter will try the attachment's asset identifier through `/rest/assets/<id>` when available.

## HTTP 429

The client honors `Retry-After` and uses exponential backoff. Increase the dashboard request delay if rate limits continue. Do not run multiple exporters against the same account concurrently.

## Incomplete validation report

Open `reports/validation.md`, then inspect `reports/failures.jsonl` and the affected conversation's `validation.json`. Starting another run retries incomplete conversations while skipping valid unchanged ones.

Do not create `complete.json` manually. It binds the listing hash, raw capture hash, normalized hash, and validation result.

## Grok endpoint changed

1. Preserve the failed run journal and redacted error code; do not publish the archive.
2. In DevTools Network, observe the requests Grok itself makes when opening history and one synthetic/non-sensitive conversation.
3. Compare the list, metadata, response-node, and load-responses shapes with `docs/UPSTREAM_RESEARCH.md`.
4. Add a synthetic contract fixture for the new envelope before changing an adapter.
5. Keep previous raw fields and envelope readers until a migration test demonstrates compatibility.

Never post session cookies, authorization headers, signed asset URLs, or real conversation payloads in an issue.

