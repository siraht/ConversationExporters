# Installation and use

GrokExporter currently targets Chromium-based desktop browsers with the File System Access API, including Chrome, Chromium, Brave, and Edge.

## Install from source

```bash
git clone https://github.com/siraht/GrokExporter.git
cd GrokExporter
npm install
npm run check
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist/extension` directory. Reload any `grok.com` tab that was already open.

To create a portable extension archive:

```bash
npm run package
```

The deterministic ZIP is written to `dist/releases/`. Unzip it before using **Load unpacked**; the Chrome Web Store is not required.

## Export your history

1. Open `https://grok.com`, sign in, and verify that the history page works.
2. Click the GrokExporter toolbar action. Its dashboard opens in a new tab.
3. Create or choose a dedicated empty archive directory. The exporter writes its manifest, conversations, assets, journals, and reports directly there.
4. Keep **Download referenced assets** enabled for the most complete archive. A 500 ms request delay and response batch size of 50 are conservative defaults.
5. Choose **Start or resume export**. You can pause before the next network request, cancel safely, or close the dashboard and start again later.
6. Do not treat the run as finished until the dashboard reports every inventory conversation complete. Open `reports/validation.md` and review any asset issues.

Starting another run is incremental. GrokExporter follows the current conversation list again, skips completion markers whose listing hashes are unchanged, retries unfinished conversations, and reports remote deletions without deleting local data.

## Archive contents

The archive root contains:

- `inventory.json`: the token-complete current Grok history inventory;
- `runs/`: durable state and errors for each attempted export;
- `conversations/<id>/source/`: untouched listing, metadata, response-node, and response-batch payloads;
- `conversation.json` and `conversation.md`: normalized portable and readable forms;
- `assets/` and `assets.json`: content-hashed media plus capture status;
- `indexes/`: compact JSON Lines indexes for search and downstream ingestion;
- `reports/validation.json` and `.md`: the final completeness audit;
- `archive.json`: archive identity, counts, latest run, and remote-deletion observations.

Raw payloads can contain every sensitive detail present in a conversation. Back up and transfer the archive as private data; never commit it to this repository.

