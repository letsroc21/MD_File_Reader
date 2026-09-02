# MD File Reader — Round 2: Bug Fixes + App Icon

The Tauri rebuild matches the v1 spec architecturally (raw-text buffer, atomic writes, file associations). A code review found four real bugs — two of them break headline features — plus two hygiene items. Fix these, add the custom icon, then run the verification pass at the bottom. Do not restructure anything that already works.

## Bug 1 — Files opened from Finder at launch are lost (critical)

**Where:** `queue_or_open` in `src-tauri/src/lib.rs`.

**Problem:** The function only adds files to the pending queue when zero webview windows exist; otherwise it emits an `open-files` event. But the main window is created from `tauri.conf.json` at startup, *before* React has loaded and registered listeners. So when macOS delivers the file-open event during launch (`RunEvent::Opened`), the window count is nonzero, the event fires into a webview with no listener, and the file is silently dropped — the user gets the start screen instead of their document. This breaks the app's primary use case: double-clicking a `.md` file in Finder.

**Fix:** Always push opened files onto the pending queue, and also emit the event. The frontend already calls `take_pending_files` on mount — make sure that drain path and the event path can't double-open the same file (e.g. clear pending before emitting to live listeners, or have the frontend dedupe by path).

## Bug 2 — Cmd+Q with unsaved changes deadlocks quit (critical)

**Where:** `RunEvent::ExitRequested` handler and `set_window_dirty` / `AppState.dirty` in `src-tauri/src/lib.rs`.

**Problem A:** On quit with dirty windows, the handler calls `api.prevent_exit()` and emits `quit-requested`; each window shows its save dialog and destroys itself — but nothing ever calls `app.exit()` afterward. On macOS the app keeps running with no windows. Quit never completes.

**Problem B:** Dirty labels leak. When a window closes after the user picks "Don't Save," its label is never removed from `AppState.dirty`, so `has_dirty()` returns true forever and every future Cmd+Q is blocked — even with all documents saved.

**Fix:** Remove a window's label from the dirty set whenever that window is destroyed (listen for the window destroyed event in Rust, don't rely on the frontend). After a quit was requested and the last window resolves (saved or discarded and closed), call `app.exit(0)`. Cancel in any window's dialog cancels the whole quit.

## Bug 3 — Opening a file can open it twice (multi-window broadcast)

**Where:** `open-files` event handling in `src/App.tsx` (every window registers the same listener) and `queue_or_open` in `lib.rs`.

**Problem:** The event is broadcast to all windows and each one acts on it. With a blank start window plus a document window open, the blank window loads the file in place *while* the document window also calls `open_in_new_window` for the same path — the file opens in two windows.

**Fix:** Route each opened file to exactly one target from the Rust side: if a blank/start window exists, send the file to that window only (use `emit_to` with the window label); otherwise create the document window directly in Rust via `create_document_window`. Remove the per-window fan-out logic from the frontend listener.

## Bug 4 — Print (Cmd+P) is a no-op

**Where:** `handlePrint` in `src/App.tsx` uses `window.print()`.

**Problem:** `window.print()` does nothing in WKWebView on macOS, so Cmd+P and the Print button silently fail.

**Fix:** Call Tauri's native webview print API (`getCurrentWebview().print()` from `@tauri-apps/api`, or invoke a Rust command that calls `webview.print()`). Keep the existing behavior of switching to Reading view first so the print output is the rendered document with the print stylesheet.

## Hygiene 1 — Replace raw `rfd` dialogs with the dialog plugin

`pick_save_path` and `unsaved_dialog` in `lib.rs` use blocking `rfd` dialogs directly, while `pick_file` correctly uses `tauri-plugin-dialog`. AppKit dialogs are main-thread-only on macOS; the raw calls risk hangs/crashes. Convert both to `tauri-plugin-dialog`, and give the unsaved-changes dialog proper macOS button labels: **Save** (default) / **Don't Save** / **Cancel** — not Yes/No. Drop the `rfd` dependency from `Cargo.toml` once nothing uses it.

## Hygiene 2 — Sanitize Reading-view HTML

`ReadingView.tsx` renders markdown-it output with `html: true` straight into `dangerouslySetInnerHTML`. CSP currently blocks inline script, but this app's job is opening arbitrary downloaded files — add DOMPurify (or equivalent) over the rendered HTML before insertion, configured to keep benign tags/attributes (including `input[type=checkbox]` for task lists and resolved `asset:`/`http://asset.localhost` image URLs).

## App icon

An icon image is attached (source PNG). Integrate it as the app icon:

1. Save the attached image as `src-tauri/icon-source.png`. If it isn't already 1024×1024 with transparency, resize/pad it to 1024×1024 first.
2. Generate the full icon set, overwriting the placeholder icons:
   ```bash
   npx tauri icon src-tauri/icon-source.png
   ```
   This regenerates everything in `src-tauri/icons/` including `icon.icns` (macOS) — the existing `bundle.icon` list in `tauri.conf.json` already points at these files, so no config change should be needed. Verify `icon.icns` was actually regenerated (check file modification time).
3. Rebuild (`npm run dist`) and confirm the new icon shows on the `.app` bundle and in the Dock. Note: Finder caches icons — if the old icon shows after copying to /Applications, rename or re-copy the bundle, or run `killall Finder`.

## Verification (run all of these before reporting done)

1. `cargo test` passes and `npx tsc --noEmit` is clean.
2. **Launch-with-file:** `npm run dist`, copy the `.app` to /Applications, quit any running instance, then `open -a "MD File Reader" samples/fidelity.md` — the file must render, not the start screen. Repeat with the app already running: the file opens in one window, exactly once.
3. **Fidelity:** open `samples/fidelity.md` in the packaged app, press Cmd+S without editing, then `git diff samples/fidelity.md` must be empty.
4. **Quit flow:** make an untitled doc dirty, Cmd+Q → Save / Don't Save / Cancel sheet. "Don't Save" → app fully quits (not just window closes). Then relaunch, open a file, save it, Cmd+Q → quits immediately with no dialog (proves no dirty-label leak).
5. **Double-open:** with a blank start window and a document window both open, double-click a `.md` in Finder → it opens in exactly one window.
6. **Print:** Cmd+P shows the macOS print dialog with the rendered Reading view.
7. **Icon:** the packaged `.app` shows the custom icon in Finder and the Dock.
