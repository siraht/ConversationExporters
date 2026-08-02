# ConversationExporters

ConversationExporters is the shared source tree for two independently accepted browser extensions:

- GrokExporter inventories and downloads the complete Grok web history exposed to the signed-in user.
- ChatGPTExporter inventories and downloads the complete ChatGPT web history exposed by the selected accessible workspace and scope set.

The repository shares only behavior proven equivalent by the standalone releases. Provider authentication, endpoint construction, pagination, envelope parsing, normalization, asset rules, and host permissions remain provider-owned. Builds still produce two separate Manifest V3 extensions, so installing either exporter grants no access to the other provider.

## Packages

- `packages/shared` contains provider-neutral JSON, hashing, serialization, and archive primitives.
- `packages/grok-exporter` descends from accepted GrokExporter `v0.1.0`.
- `packages/chatgpt-exporter` descends from accepted ChatGPTExporter `v0.1.6`.

Run `npm install`, then `npm run check`. Build both extensions with `npm run build`, or build one with `npm run build:grok` or `npm run build:chatgpt`. Release archives are produced independently with `npm run package:grok` and `npm run package:chatgpt`.

Private exports, browser profiles, credentials, signed URLs, and personal conversation data do not belong in this repository.

