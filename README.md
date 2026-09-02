# MD File Reader

A small macOS app for reading and writing Markdown files. Double-click a `.md` file in Finder and it opens here — rendered, editable, and saved back as the same text.

This is a Tauri 2 app. The editor keeps the **raw Markdown buffer** as the source of truth, so opening and saving without edits does not rewrite the file.

## Run it

You need Rust (`rustup`) and Xcode command-line tools.

```bash
npm install
npm run dev
```

## Make it the default .md app

```bash
npm run dist
```

That builds `src-tauri/target/release/bundle/macos/MD File Reader.app`. Copy it to `/Applications`.

Then in Finder: select any `.md` file → **Get Info** → **Open with** → **MD File Reader** → **Change All**.

If macOS blocks the first launch, right-click the app → **Open**, or run:

```bash
xattr -cr "/Applications/MD File Reader.app"
```

Finder spacebar preview is separate; [QLMarkdown](https://github.com/sbarex/QLMarkdown) covers that.

## Views

- **Live** (`Cmd+1`) — Obsidian-style live preview over the raw text
- **Source** (`Cmd+2`) — plain Markdown
- **Reading** (`Cmd+3`) — read-only rendered HTML, also used for Print / Save as PDF (`Cmd+P`)

Themes: Paper, Sepia, Night. Autosave is on for files that already have a path.

`samples/fidelity.md` is the round-trip test file (front matter, tables, task lists, raw HTML, footnotes).
