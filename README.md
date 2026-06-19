# OMP Annotation Panel

Chrome/Brave MV3 extension for sending visual annotations from a browser page into an OMP/Codex chat.

<img width="2258" height="1122" alt="image" src="https://github.com/user-attachments/assets/9b3e32fd-b161-4f3e-85c2-6bc283f48d12" />


It provides:

- A browser side panel with an **OMP target** field.
- Element annotations: click a page element, add a note, send it with viewport dimensions.
- Box annotations: draw a rectangle, add a note, send it with viewport dimensions and a compressed screenshot.
- Fast startup from a copied OMP target block.
- An OMP bridge extension that receives annotations and forwards them to the active chat through `cmux`.
- A browser-injected fallback annotator for `/annotate <url>` sessions inside OMP.

## Requirements

- macOS.
- Chrome or Brave with extension developer mode enabled.
- Node.js for tests and installer scripts.
- OMP installed with a writable `~/.omp/agent` directory.
- `cmux` installed at `/Applications/cmux.app/Contents/Resources/bin/cmux` for chat delivery.

## Install the browser extension

1. Clone this repository.
2. Open Chrome/Brave extensions:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this repository directory.
6. Pin the extension if desired.

The default extension shortcut is `Alt+Shift+O` to open the side panel. Chrome/Brave may require assigning or confirming shortcuts at `chrome://extensions/shortcuts` or `brave://extensions/shortcuts`.

## Install the OMP bridge

Run:

```sh
npm install
npm run install:omp
```

The installer writes:

- `~/.omp/agent/extensions/annotation-bridge.js`
- `~/.omp/agent/extensions/omp-session-annotator.js`
- `~/.omp/agent/commands/annotate.md`
- `~/.local/bin/omp-annotation-install`

It also ensures `~/.omp/agent/config.yml` loads the bridge extension.

After installing or changing the bridge, restart the current OMP session. OMP loads agent extensions at session startup.

## OMP target block

The browser extension needs a target block copied from the receiving OMP/cmux chat. It looks like this:

```text
workspace_ref=workspace:10
workspace_id=15D6654A-6373-4CC9-88F3-33BF466AA23B
pane_ref=pane:74
pane_id=3DE0D561-9E0B-41A1-A705-916AEB3C53B1
surface_ref=surface:78
surface_id=EFBA65E7-E985-40CD-A70C-D6CE29B99F03
```

### How to copy the IDs from an OMP tab

Use **Copy IDs** from the tab menu in the OMP/cmux interface.

<img width="513" height="490" alt="image" src="https://github.com/user-attachments/assets/a483e150-d562-4883-b8a6-7dabe474aee9" /><br><br>


Steps:

1. Go to the OMP chat that should receive annotations.
2. Right-click the tab title for that chat.
3. Click **Copy IDs**.
4. The clipboard now contains the `workspace_ref`, `workspace_id`, `pane_ref`, `pane_id`, `surface_ref`, and `surface_id` block.
5. Open the browser extension immediately after copying. The extension reads that clipboard block and fills **OMP target**.

The copied IDs identify the exact OMP workspace, pane, and surface that should receive annotation messages. If you switch chats, fork the conversation, move to a different pane, or reopen OMP, copy IDs again before annotating.

When that text is on the clipboard and the extension opens, the side panel attempts to:

1. Read the clipboard.
2. Fill the **OMP target** textarea.
3. Pair with the target.
4. Start annotation mode.
5. Switch to Element mode so annotation can begin immediately.

If the browser blocks automatic clipboard access, click the OMP target field and paste manually. Once the field contains the target block, the extension can pair and send.

## Browser side panel workflow

1. Copy the OMP target block from the receiving chat.
2. Open the extension with the toolbar icon or `Alt+Shift+O`.
3. Confirm the **OMP target** field is filled and shows paired status.
4. Use one of the modes:
   - **Element**: click an element, write a note, send.
   - **Box**: drag a rectangle, write a note, send.
5. Press `Esc` or click **Esc** to stop and clean up the page overlay.

Useful shortcuts:

- `Alt+Shift+A`: start/stop annotation.
- `Alt+Shift+E`: Element mode.
- `Alt+Shift+B`: Box mode.
- `Alt+Shift+``: toggle between Element and Box mode while annotation is active.
- `Esc`: stop annotation and remove the overlay.
- `Enter`: send the current note.
- `Cmd+Enter` / `Ctrl+Enter`: save note without sending.
- `Shift+Enter`: insert a newline.

Every sent annotation includes the current viewport width, viewport height, and device pixel ratio. This helps the receiver distinguish desktop-visible UI from mobile-hidden UI.

## Screenshot behavior

Box annotations capture a screenshot of the selected page region.

The extension:

1. Calls `chrome.tabs.captureVisibleTab()`.
2. Crops the selected box using the captured bitmap scale.
3. Downscales the crop by 2x.
4. Caps output width at 1920 px.
5. Converts the result to WebP at quality `0.85`.
6. Sends screenshot metadata and image data to the bridge.

The bridge writes received screenshots to:

```text
/tmp/omp-annotation-screenshots/
```

The chat message includes a line like:

```text
SCREENSHOT_PATH=/tmp/omp-annotation-screenshots/annotation-1781879559892-1.webp
```

That path lets an agent read the image directly. The bridge does not paste raw base64 into chat text.

## OMP bridge annotation skill

The bridge supports two paths.

### 1. External browser extension path

Use this when annotating an already-open Chrome/Brave page.

- The extension sends annotations to the local bridge server.
- The bridge validates the session token.
- The bridge writes screenshot files when present.
- The bridge formats a compact chat message.
- The bridge sends it to the target `cmux` surface.

### 2. `/annotate` command path

After `npm run install:omp`, OMP has a fallback command:

```text
/annotate https://example.com
```

That command instructs the OMP browser workflow to:

1. Open the URL in a cmux/default browser tab.
2. Inject `~/.omp/agent/extensions/omp-session-annotator.js`.
3. Start the in-page annotator.
4. Poll `window.__ompSessionAnnotator.drainOutbox()`.
5. Post annotations back to the chat.
6. Stop when the annotator reports `done`.

Use the extension path for Chrome/Brave pages. Use `/annotate` when you want OMP to open and manage the browser page itself.

## Development

Install dependencies:

```sh
npm install
```

Run tests:

```sh
npm test
```

Run the browser smoke test visibly:

```sh
npm run test:foreground
```

Run the headless browser smoke test:

```sh
npm run test:headless
```

After changing `src/annotation-bridge.js` or `src/omp-session-annotator.js`, reinstall and restart OMP:

```sh
npm run install:omp
```

After changing extension files, reload the unpacked extension in Chrome/Brave.

## Troubleshooting

### OMP target field stays blank

Browser clipboard reads require permission and usually a user gesture. Open the extension with its shortcut or toolbar button while the target block is on the clipboard. If it still stays blank, paste manually into **OMP target**.

### Start works but annotations do not reach chat

Check that:

- The OMP target block is current.
- The target `surface_ref` still exists.
- The OMP bridge was installed with `npm run install:omp`.
- The OMP session was restarted after bridge installation.
- `cmux` exists at `/Applications/cmux.app/Contents/Resources/bin/cmux`.

### Box image does not appear

The expected chat output is not a base64 image. It should include `SCREENSHOT_PATH=...`. If that line is missing, reload the browser extension, reinstall the bridge, restart OMP, and try another Box send.

### Yellow overlay remains after stopping

Press `Esc`, click the side panel **Esc** button, or reload the extension. The current content script clears boxes, pins, notes, outlines, and drag overlays when annotation mode stops.

## Repository layout

```text
manifest.json                      Chrome/Brave extension manifest
src/background.js                   MV3 service worker and screenshot capture
src/content.js                      Page overlay, element/box annotator, cleanup
src/sidepanel.html                  Side panel markup
src/sidepanel.css                   Side panel styles
src/sidepanel.js                    Side panel state, clipboard bootstrap, controls
src/annotation-bridge.js            OMP bridge extension and cmux delivery
src/omp-session-annotator.js        In-page annotator used by /annotate
scripts/install-omp-annotation.mjs  OMP bridge installer
tests/*.mjs                         Smoke and bridge tests
```
