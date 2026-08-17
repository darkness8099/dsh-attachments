<div align="center">

# 📎 dsh-attachments

**Drag-and-drop file and folder attachments for DeepSeek Harness.**

[简体中文](README.md) · **English**

[![CI](https://github.com/WJZ-P/dsh-attachments/actions/workflows/ci.yml/badge.svg)](https://github.com/WJZ-P/dsh-attachments/actions/workflows/ci.yml)
![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-111827)
![Version](https://img.shields.io/badge/version-1.0.1-2563eb)
![License](https://img.shields.io/badge/license-MIT-22c55e)

</div>

---

`dsh-attachments` adds file and folder attachments to the DeepSeek Harness Web UI. Images continue through Harness's native upload, preview, and persistence pipeline; the optional model adapter composes those native references with a configured vision route when the selected main model is text-only.

## Features

- Drop ordinary files, images, or folders from the operating system.
- Keep native PNG/JPEG/WebP/GIF preview, history gallery, and model-capability checks.
- Compose a text-only main model with image-capable routes already configured in DSH.
- Represent one dropped folder as one attachment card while preserving its directory tree.
- Copy committed files and folders into `.deepseek-harness/attachments/` in the active workspace before the model step.
- Render attachment cards in both the composer and persistent message history.
- Stream upload and download bytes without adding plugin-defined file-count or per-file-size limits.
- Leave the original composer layout unchanged while no plugin-owned attachment is present.

## Vision bridge

The vision bridge reuses providers, API endpoints, credentials, protocol adapters, and models from DSH's native Models page. It never asks for a second API key and does not reimplement OpenAI, Zhipu, or other provider wire formats.

1. Configure any main models you want to use and at least one model that explicitly advertises image input in DSH's Models page.
2. Optionally list preferred vision models in the current profile's Loader patch. These entries reference native provider and model IDs; they do not repeat API endpoints or credentials.
3. Keep selecting the main model normally. When a draft contains images and that current model explicitly lacks image input, the plugin offers explicit and discovered vision candidates while retaining the current model for final reasoning.

For example:

```yaml
- id: dsh-attachments
  config:
    visionBridge:
      visionModels:
        - id: glm-4.5v
          name: GLM-4.5V
          provider: zhipu
          model: glm-4.5v
```

`discoverVisionModels` defaults to `true`. The plugin reads registered DSH provider catalogs and appends models that explicitly advertise `image` input. Explicit `visionModels` stay first and suppress discovered duplicates for the same provider route. Set `discoverVisionModels: false` to use only the explicit allowlist.

The plugin does not make API calls to probe credentials or account entitlements, and it never generates the Cartesian product of main and vision routes. The main route is read from the current session only when image bridging is requested. The adapter's global model catalog stays empty; one unlisted, session-bound route is created for the selected vision candidate and retired when the user selects another main model.

Vision candidates never replace DSH's default model. During ordinary text-only use the bridge guide stays hidden. It appears above the composer after images are attached, the current model explicitly lacks image input, and at least one vision route is usable. One candidate produces one button; several candidates produce a vision-only selector with explicit routes first and discovered routes grouped by provider. The button activates a session-bound bridge but never submits the draft, and immediately restores the underlying main route as the default for future sessions. Once active, the full guide collapses; when alternatives exist, a compact `Vision` control appears immediately left of the native model selector. A current model with native image support keeps its own multimodal route and receives no bridge.

Model changes use the same capability-based policy. If a conversation already contains native images and the user chooses any explicitly text-only model, the browser preflights that exact target before DSH receives the selection. A usable vision candidate produces the same confirmation guide, and confirmation selects a temporary route with the newly chosen model as main. Once a bridge is active, the compact control beside the native model selector changes the vision route immediately without submitting a message, changing the main model, or rescanning existing evidence. Native vision targets, image-free conversations, targets with unknown modality metadata, and deployments without a usable vision candidate retain DSH's native selection behavior. This preflight is provider-agnostic and never creates global main-by-vision aliases.

Vision evidence is logged in the same DSH session as a standard collapsed context-injection row. Expanding it shows the route and complete evidence. Original image references are neither removed nor replaced. Images attached to the current message are still described before the main model's first decision. Historical images are instead exposed to the main model as a metadata-only inventory: the main model can answer counts and filenames, ask the user to identify a target, or call `analyze_session_images` with exact attachment ids and focused visual instructions. The plugin no longer guesses historical-image intent from natural-language keywords or terminates a whole request merely because several images exist.

Old sessions follow a “new images automatically, historical images on demand” policy:

- Images attached to the current user message are described automatically.
- The text-only main receives a stable inventory of native ImageBlocks and legacy markdown image references without reading image pixels.
- Historical images are never selected by outer text rules; the main model decides whether to answer, clarify, or call the vision tool.
- The tool accepts only exact attachment ids from the inventory and returns explainable errors for missing targets, inventory-only legacy references, or count-limit violations.
- The tool reuses the latest evidence for the same attachment and vision route by default. It starts a new paid analysis only when the main model sets `refresh: true` because the user requested it or existing evidence is insufficient.
- Successful evidence is committed per image; any required image failure blocks the main model.
- A failed, canceled, or outcome-unknown request is not repeated automatically; a structured refresh can authorize one new attempt.

The bridge follows DSH's image-count limit by default, and `visionBridge.maxImagesPerTurn` may set a lower bound. Omitting `visionBridge` or setting `visionBridge: false` leaves the bridge provider unregistered. When enabled, discovery is on by default and the explicit list may be empty. Disabling `discoverVisionModels` requires at least one `visionModels` entry. These settings control composition only and never store provider credentials.

## Screenshots

### Drag-and-drop surface

The plugin adds its window-level dashed drop boundary while preserving Harness's native image-intake surface.

![Drag-and-drop attachment surface](assets/screenshots/01-drag-drop-overlay.png)

### Image conversation history

Native image messages continue to render in persistent conversation history and remain available to multimodal models.

![Image message and model response](assets/screenshots/02-image-conversation.png)

### Multiple image previews

Multiple native image previews share the composer attachment rail used by plugin-provided file and folder cards.

![Multiple image previews in one prompt](assets/screenshots/03-multiple-image-preview.png)

## Install

Install the standalone repository directly from GitHub into the `desktop` profile
used by DSH Desktop:

```sh
dsh plugin --profile desktop add github:WJZ-P/dsh-attachments
```

This explicit source is intentional: the unscoped `dsh-attachments` name on npm
belongs to a different project. The marketplace uses this standalone GitHub
repository until the plugin has a distinct registry package.

Build and install a local checkout:

```sh
pnpm install
pnpm run build
dsh plugin --profile desktop add .
```

Inspect the composed profile and start DSH:

```sh
dsh --profile desktop --dump-config
dsh --profile desktop
```

Remove the plugin:

```sh
dsh plugin --profile desktop remove dsh-attachments
```

## DSH package contract

This package follows the installable DSH bundle format:

- `dsh.bundle.patch` points to `cordis.patch.yml`, which inserts the Host plugin row.
- `dsh.client.platform` is `web`, and `exports["./client"]` exposes the prebuilt browser bundle.
- Official `@deepseek-ai/*` compatibility packages are declared as peer dependencies.
- The npm tarball contains prebuilt `lib/` artifacts, so registry installs do not need to build the browser bundle.

The Host half owns byte transport, durable metadata, and workspace materialization. The browser half contributes composer and history UI through Harness extension slots. The package has no Tauri runtime dependency.

## Compatibility

The current development version targets DeepSeek Harness `0.1.0-rc.6`: standard bundle loading, web client discovery, conversation input/history slots, session events, native attachments, and LLM adapter registration.

## Development

```sh
pnpm install
pnpm run build
pnpm test
npm pack --dry-run
```

The ready-to-copy catalog YAML and screenshot URL template are maintained in [MARKETPLACE.md](MARKETPLACE.md). Screenshot files belong in [`assets/screenshots/`](assets/screenshots/).

## License

[MIT](LICENSE)
