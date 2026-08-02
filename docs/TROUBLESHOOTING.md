# Troubleshooting

## No ChatGPT tab found

Open `https://chatgpt.com/` in the same Chromium profile where the extension is installed, finish normal sign-in, refresh the page once so the content scripts load, then choose **Find tab** again. Incognito and a different browser profile are separate extension contexts.

## Authentication required

The short-lived session expired or the selected workspace is no longer authorized. Sign in or refresh the normal ChatGPT tab, find it again, select the same workspace, and rerun preflight. Never paste a token or cookie into the extension or an issue. Existing local raw files and completion markers remain resumable.

## Rate limited

Wait for the displayed cooldown, keep concurrency at 1, increase the request delay, and resume. Do not open multiple exporter runs for the same account. A `429` does not expose or retain its response body.

## Directory permission required

Browser directory permissions may expire after a restart. Verify the workspaces, choose the same parent directory, and grant read/write access again. Each workspace directory is located by its stable fingerprint, so valid completion markers are reused.

## Inventory stops incomplete

Repeated pages/cursors, premature empty pages, malformed envelopes, and configured page/byte limits are intentional fail-closed conditions. Keep the written `source/inventory/` evidence private, rerun once after refreshing ChatGPT, and report a sanitized shape if it repeats. Do not confirm or hand-edit an incomplete inventory.

## Conversations complete but assets partial

Open `reports/validation.md` and the affected conversation/project `assets.json`. Common causes are provider-deleted files, expired authorization, access denied in another workspace, or a new descriptor shape. Rerunning capture retries partial asset scopes while skipping hash-valid conversations. A documented irretrievable provider file can remain explicit; it must never be labeled downloaded.

## Revalidation reports incomplete

Revalidation makes no provider requests. A missing/hash-mismatched derived file can usually rebuild by running capture again if its raw detail marker remains valid. A missing or corrupted raw detail requires a provider refetch; keep the failed evidence and do not edit marker hashes.

## Build or packaged browser test fails

Use Node.js 20+, run `npm ci`, then `npm run check`. The packaged test needs Chromium; install Playwright Chromium with `npx playwright install chromium` or set `CHATGPT_EXPORTER_CHROME` to a compatible executable. The extension must remain Manifest V3 with only the permissions declared in `public/manifest.json`.

## Reporting a bug safely

Include the source commit, extension version, aggregate scope/count state, safe error code/status/correlation ID, and a minimal synthetic fixture if possible. Exclude conversation IDs, titles, bodies, account/workspace IDs, file names, archive paths, tokens, cookies, browser profiles, HAR files, full response bodies, and signed URLs.
