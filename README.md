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

Wiki links (`[[Note]]`, `[[Note|alias]]`) open a Markdown file in the same folder. Click in Reading; click in Live unless the cursor is on that line; Cmd-click in Source.

## Updates

The Dock app is a copy of a build you installed into `/Applications`. It does not download a new `.app` by itself.

**Updates** (or **Check for updates** on the start screen) looks at the latest commit on GitHub `main` and compares it with the commit baked into this install. If GitHub is ahead, it can open the repo. To actually update the Dock app, rebuild and replace it:

```bash
npx tauri build --bundles app
```

Then copy the new `.app` over `/Applications/MD File Reader.app` and quit/relaunch.

True auto-install (Sparkle-style) needs signed GitHub Releases and a Tauri updater keypair. This project does not do that yet because you currently ship by building locally.

`samples/fidelity.md` is the round-trip test file (front matter, tables, task lists, raw HTML, footnotes).
