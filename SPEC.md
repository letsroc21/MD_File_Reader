# MD File Reader — v1 Rebuild Spec (Tauri)

## Problem statement

Opening `.md` files on my Mac is clunky: an IDE is overkill, doesn't render markdown nicely, and editing-then-saving is awkward. I want a small, fast native app I can set as the **macOS default application for `.md` files** — double-click in Finder, see a beautifully rendered document, edit it in place, and save with zero risk of the file being rewritten or corrupted.

## Verdict on the current codebase

The existing Electron + React + Tiptap prototype (this repo) proved the UX but has two structural problems: (1) it has no packaging step, so it cannot be registered as a default file handler at all, and (2) Tiptap's parse→edit→re-serialize round trip silently mangles content it doesn't model (tables, task lists, raw HTML, YAML front matter). **This spec is a rebuild, not a patch.** Reuse UI ideas (themes, view modes, chrome) but not the Electron main process or the Tiptap editing model.

## Decisions (already made — do not relitigate)

1. **Framework: Tauri 2.x.** Small binary (~10MB), near-instant cold start on the system WKWebView, first-class `fileAssociations` support. Frontend stays React + TypeScript + Vite.
2. **Editing model: live-preview editor (Obsidian/Typora style).** One CodeMirror 6 instance editing the **raw markdown text**, which is the canonical document state at all times. Formatting is rendered inline via decorations; syntax markers reveal on the active line. Saving writes the exact buffer text — fidelity is guaranteed by construction.
3. **In scope for v1:** file association + packaging, quit/close guard, atomic writes, autosave, Open Recent, print/export-to-PDF, external file-change detection.

## Architecture

- **Frontend:** React + TS + Vite. CodeMirror 6 with `@codemirror/lang-markdown` (GFM extensions enabled) as the single editor surface.
- **Backend (Rust):** keep it thin. File read/write commands, atomic save, file watcher, recent-files persistence, native dialogs (via Tauri plugins where possible: `dialog`, `fs`, `single-instance`, `window-state`).
- **No remote content.** Strict CSP. Tauri `fs` scope limited to user-selected/opened files plus their directories (needed for relative images). No network access.

## View modes

Three modes, persisted per app (not per file), keyboard-switchable:

| Mode | Shortcut | Behavior |
|---|---|---|
| **Live Preview** (default) | Cmd+1 | CM6 with inline rendering: headings styled at size, bold/italic rendered, syntax markers (`#`, `**`, etc.) hidden except on the active line, task-list checkboxes clickable (toggling edits the source), tables readable, code fences syntax-highlighted, links Cmd+clickable, front matter rendered as a dimmed metadata block. |
| **Source** | Cmd+2 | Same CM6 buffer, plain markdown syntax highlighting only, no rendering decorations. Same document, same undo history — switching modes never touches the text. |
| **Reading** | Cmd+3 | Read-only rendered HTML (remark/unified or markdown-it with GFM: tables, task lists, strikethrough, autolinks, footnotes). This is also the surface used for printing/PDF export. |

Live-preview decoration work is the hardest part of this build. Study/borrow from existing CM6 rich-markdown implementations (e.g. `codemirror-rich-markdoc`, HyperMD's approach, Obsidian's visible behavior) rather than inventing from scratch. If a particular construct is too hard to render inline (e.g. complex tables), it is acceptable for v1 to show it as highlighted source inside Live Preview — never break the text.

## File handling (the core of this app)

### Association & packaging
- `tauri.conf.json` `bundle.fileAssociations`: `md`, `markdown`, `mdown`, `mkd` (role: Editor, UTI `net.daringfireball.markdown`); `txt` as a secondary association (role: Viewer).
- Produce a signed `.app` and `.dmg` via `tauri build`. Ad-hoc signing is acceptable for personal use; document the `xattr -cr` / right-click-open step if unsigned.
- Handle macOS open events: file opened at launch, file opened while running (Apple Event → Tauri `RunEvent::Opened`), and `open -a` / CLI argv.
- **Single instance** (plugin) — a second Finder open must route to the running app.
- **Multi-window:** each file opens in its own window (Finder default-app behavior; users select multiple files and hit Cmd+O). Window per document, independent dirty state, native window menu. Restore window size/position via `window-state` plugin.

### Reading
- Read as UTF-8; detect and preserve the file's line-ending style (LF/CRLF) and presence/absence of trailing newline — write back exactly what convention the file used.
- YAML front matter passes through untouched (it's just text in the buffer).
- Relative image paths resolve against the file's directory using Tauri's asset protocol (`convertFileSrc`) in Reading mode and Live Preview.

### Saving
- **Atomic writes:** write to a temp file in the same directory, fsync, rename over the original. Preserve file permissions.
- Cmd+S saves; Cmd+Shift+S Save As (don't double-append `.md` to names already ending in `.markdown` etc.).
- **Autosave:** on by default for files that have a path — debounce ~1.5s after last edit, plus save on window blur. Untitled documents are never autosaved (Cmd+S triggers Save As). A subtle "Saved"/"Edited" indicator in the chrome replaces the dirty dot when autosave is on.
- **Quit/close guard:** intercept window close and Cmd+Q. If any window has unsaved changes (in practice: untitled docs, or a save that failed), show the native three-button sheet — **Save / Don't Save / Cancel** (macOS convention, Save is default).

### External change detection
- Watch the open file (`notify` crate). If it changes on disk and the buffer is **clean** → reload silently (preserve scroll/cursor if possible). If the buffer is **dirty** → non-blocking banner: "File changed on disk — Reload / Keep mine". This matters because AI tools and IDEs frequently rewrite `.md` files while they're open.

### Open Recent
- Persist a recent-files list (last 15) in app data. Native **File → Open Recent** submenu with Clear. On launch with no file argument, show a lightweight start state (recent list + Open button + drag-drop target) — do not auto-reopen the last file.

## Print / Export PDF
- Cmd+P prints the **Reading-mode render** with a dedicated print stylesheet (comfortable margins, page-break-avoid inside code blocks/tables, black-on-white regardless of theme). macOS's print dialog provides Save-as-PDF for free; add an explicit **File → Export as PDF…** menu item that invokes the same pipeline.

## UI & chrome
- Keep the current design language: hidden-inset title bar, compact chrome with filename + save state, mode switcher, and the three themes (**Paper / Sepia / Night**) with persisted choice. Night must also set the native window/titlebar appearance dark.
- Drag-and-drop a file onto the window opens it (in a new window if the current one has a document).
- Editor niceties: Cmd+B/I toggles bold/italic markers around selection, Cmd+K wraps a link, `Tab` indents list items, typing `- ` / `1. ` / `> ` continues lists/quotes on Enter.
- No format toolbar needed in v1 (live preview + shortcuts covers it); if trivial, a minimal one is fine.

## Non-goals (v1)
- Quick Look / spacebar preview in Finder (separate macOS extension; recommend installing QLMarkdown alongside).
- Windows/Linux support, tabs, sync, plugins, mermaid/LaTeX rendering, WYSIWYG table editing.

## Acceptance criteria
1. `tauri build` produces a `.app`; after "Open With → Always", double-clicking any `.md` in Finder opens it rendered in under ~1 second.
2. Open a markdown file containing YAML front matter, a GFM table, task lists, raw HTML, and footnotes; press Cmd+S without editing → `git diff` on the file is **empty**.
3. Edit in Live Preview, toggle a task checkbox, switch to Source → the source shows exactly those edits and nothing else.
4. Kill the app mid-save (or simulate) → original file is never left truncated/corrupted.
5. Cmd+Q with an unsaved untitled doc → native Save / Don't Save / Cancel sheet.
6. Modify the open file from another app: clean buffer reloads automatically; dirty buffer shows the Reload/Keep banner.
7. Autosave: type in a titled file, wait 2s, force-quit → changes are on disk.
8. Open two files from Finder → two windows, independent state; second open while running does not spawn a second app instance.
9. Cmd+P on a themed (Night) document → print preview is clean black-on-white with rendered tables and code blocks.
10. A 5MB markdown file opens, scrolls, and edits without noticeable lag.

## Suggested build order
1. Tauri scaffold + file open/save/atomic-write + file associations + single instance (prove the "default app" loop end-to-end first).
2. CM6 source mode + Reading mode + view switching + themes.
3. Live Preview decorations (the long pole — iterate).
4. Autosave, quit guard, external-change watcher, Open Recent, multi-window polish.
5. Print/PDF, packaging polish, acceptance pass.
