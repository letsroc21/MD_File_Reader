import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import MarkdownEditor from "./editor/MarkdownEditor";
import ReadingView from "./reading/ReadingView";
import {
  cancelQuit,
  checkForUpdate,
  clearRecent,
  listRecent,
  openInNewWindow,
  openBlankWindow,
  pickFile,
  pickSavePath,
  printDocument,
  readDocument,
  registerWindow,
  resolveNote,
  setNativeTheme,
  setWindowDirty,
  setWindowOccupied,
  setWindowPath,
  unsavedDialog,
  watchFile,
  writeDocument,
} from "./api";
import { applyThemeToDocument, readStoredTheme, THEME_KEY, THEMES, VIEW_KEY, type Theme } from "./theme";

type ViewMode = "live" | "source" | "reading";
type SaveState = "saved" | "edited" | "idle";

function fileName(path: string | null) {
  if (!path) {
    return "Untitled";
  }
  return path.split(/[/\\]/).pop() || path;
}

function queryFile() {
  const params = new URLSearchParams(window.location.search);
  const file = params.get("file");
  return file ? decodeURIComponent(file) : null;
}

function readStoredView(): ViewMode {
  const saved = localStorage.getItem(VIEW_KEY);
  if (saved === "live" || saved === "source" || saved === "reading") {
    return saved;
  }
  return "live";
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [view, setView] = useState<ViewMode>(() => readStoredView());
  const [path, setPath] = useState<string | null>(queryFile());
  const [text, setText] = useState("");
  const [lineEnding, setLineEnding] = useState("lf");
  const [trailingNewline, setTrailingNewline] = useState(true);
  const [docId, setDocId] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [recent, setRecent] = useState<string[]>([]);
  const [diskBanner, setDiskBanner] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const dirtyRef = useRef(false);
  const textRef = useRef("");
  const pathRef = useRef<string | null>(path);
  const autosaveTimer = useRef<number | null>(null);
  const printAfterReading = useRef(false);

  pathRef.current = path;

  const hasDocument = path !== null || text.length > 0 || dirty || docId > 0;

  useEffect(() => {
    if (hasDocument) {
      setWindowOccupied(true).catch(() => undefined);
    }
  }, [hasDocument]);

  useEffect(() => {
    applyThemeToDocument(theme);
    localStorage.setItem(THEME_KEY, theme);
    setNativeTheme(theme === "night").catch(() => undefined);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  const markDirty = useCallback((next: string) => {
    textRef.current = next;
    dirtyRef.current = true;
    setText(next);
    setDirty(true);
    setSaveState("edited");
    setWindowDirty(true).catch(() => undefined);
  }, []);

  const loadPath = useCallback(async (nextPath: string, inPlace = true) => {
    if (!inPlace && hasDocument) {
      await openInNewWindow(nextPath);
      return;
    }
    const doc = await readDocument(nextPath);
    setPath(doc.path);
    pathRef.current = doc.path;
    setText(doc.text);
    textRef.current = doc.text;
    setLineEnding(doc.lineEnding);
    setTrailingNewline(doc.trailingNewline);
    setDirty(false);
    dirtyRef.current = false;
    setSaveState("saved");
    setDocId((id) => id + 1);
    setDiskBanner(false);
    setWindowDirty(false).catch(() => undefined);
    setWindowPath(doc.path).catch(() => undefined);
    try {
      getCurrentWindow().setTitle(fileName(doc.path)).catch(() => undefined);
    } catch {
      /* not in Tauri */
    }
    await watchFile(doc.path);
  }, [hasDocument]);

  const openNote = useCallback(async (target: string) => {
    const resolved = await resolveNote(pathRef.current, target).catch(() => null);
    if (!resolved) {
      return;
    }
    await loadPath(resolved, true);
  }, [loadPath]);

  const save = useCallback(async (saveAs = false) => {
    let target = pathRef.current;
    if (!target || saveAs) {
      const picked = await pickSavePath(fileName(target));
      if (!picked) {
        return false;
      }
      target = picked;
    }
    await writeDocument({
      path: target,
      text: textRef.current,
      lineEnding,
      trailingNewline,
    });
    setPath(target);
    setDirty(false);
    dirtyRef.current = false;
    setSaveState("saved");
    setWindowDirty(false).catch(() => undefined);
    setWindowPath(target).catch(() => undefined);
    try {
      getCurrentWindow().setTitle(fileName(target)).catch(() => undefined);
    } catch {
      /* not in Tauri */
    }
    await watchFile(target);
    return true;
  }, [lineEnding, trailingNewline]);

  useEffect(() => {
    if (!path || !dirty) {
      return;
    }
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = window.setTimeout(() => {
      save(false).catch(() => undefined);
    }, 1500);
    return () => {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
      }
    };
  }, [dirty, path, text, save]);

  useEffect(() => {
    const onBlur = () => {
      if (pathRef.current && dirtyRef.current) {
        save(false).catch(() => undefined);
      }
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [save]);

  const confirmClose = useCallback(async () => {
    const untitled = !pathRef.current;
    if (!dirtyRef.current && !untitled) {
      return true;
    }
    if (!dirtyRef.current && untitled && !textRef.current.trim()) {
      return true;
    }
    if (!dirtyRef.current && pathRef.current) {
      return true;
    }
    const result = await unsavedDialog(fileName(pathRef.current));
    if (result === "cancel") {
      return false;
    }
    if (result === "save") {
      return save(false);
    }
    return true;
  }, [save]);

  const confirmCloseRef = useRef(confirmClose);
  const loadPathRef = useRef(loadPath);
  confirmCloseRef.current = confirmClose;
  loadPathRef.current = loadPath;

  useEffect(() => {
    let current;
    try {
      current = getCurrentWindow();
    } catch {
      return;
    }
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      cleanups.push(await current.onCloseRequested(async (event) => {
        event.preventDefault();
        if (await confirmCloseRef.current()) {
          await current.destroy();
        }
      }));

      cleanups.push(await current.listen<string>("open-file", async (event) => {
        if (!event.payload) {
          return;
        }
        await loadPathRef.current(event.payload, true);
      }));

      cleanups.push(await current.listen("quit-requested", async () => {
        if (await confirmCloseRef.current()) {
          await current.destroy();
        } else {
          await cancelQuit();
        }
      }));

      cleanups.push(await listen<string>("file-changed", async (event) => {
        if (event.payload !== pathRef.current) {
          return;
        }
        if (!dirtyRef.current) {
          await loadPathRef.current(event.payload, true);
        } else {
          setDiskBanner(true);
        }
      }));

      cleanups.push(await listen<string[]>("recent-changed", (event) => {
        setRecent(event.payload);
      }));

      cleanups.push(await current.onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") {
          return;
        }
        const files = event.payload.paths.filter((item) =>
          /\.(md|markdown|mdown|mkd|txt)$/i.test(item),
        );
        if (!files.length) {
          return;
        }
        const [first, ...rest] = files;
        await loadPathRef.current(first, !pathRef.current && !textRef.current);
        for (const extra of rest) {
          await openInNewWindow(extra);
        }
      }));

      if (cancelled) {
        return;
      }

      listRecent().then(setRecent).catch(() => undefined);
      const files = await registerWindow().catch(() => [] as string[]);
      if (cancelled) {
        return;
      }
      const fromQuery = queryFile();
      if (fromQuery) {
        await loadPathRef.current(fromQuery, true);
        return;
      }
      if (files.length) {
        await loadPathRef.current(files[0], true);
      }
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      for (const fn of cleanups) {
        fn();
      }
    };
  }, []);

  async function handleOpen() {
    const picked = await pickFile();
    if (!picked) {
      return;
    }
    await loadPath(picked, !hasDocument);
  }

  async function handleNew() {
    if (hasDocument) {
      await openBlankWindow();
      return;
    }
    setPath(null);
    pathRef.current = null;
    setText("");
    textRef.current = "";
    setDirty(false);
    dirtyRef.current = false;
    setDocId((id) => id + 1);
    setSaveState("idle");
  }

  async function handleCheckUpdates() {
    if (checkingUpdate) {
      return;
    }
    setCheckingUpdate(true);
    try {
      await checkForUpdate();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handlePrint() {
    if (view === "reading") {
      await printDocument().catch(() => undefined);
      return;
    }
    printAfterReading.current = true;
    setView("reading");
  }

  useEffect(() => {
    if (view !== "reading" || !printAfterReading.current) {
      return;
    }
    printAfterReading.current = false;
    const timer = window.setTimeout(() => {
      printDocument().catch(() => undefined);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      if (event.key === "s") {
        event.preventDefault();
        save(event.shiftKey);
      } else if (event.key === "o") {
        event.preventDefault();
        handleOpen();
      } else if (event.key === "p") {
        event.preventDefault();
        handlePrint();
      } else if (event.key === "1") {
        setView("live");
      } else if (event.key === "2") {
        setView("source");
      } else if (event.key === "3") {
        setView("reading");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const recentNames = useMemo(
    () => recent.map((item) => ({ path: item, name: fileName(item) })),
    [recent],
  );

  const showStart = !hasDocument && !queryFile();

  return (
    <div className={`app view-${view}`}>
      <header className="chrome" data-tauri-drag-region="deep">
        <div className="chrome-title">
          <span className="app-name">MD File Reader</span>
          <span className="file-name">
            {fileName(path)}
            <span className={`save-pill save-${saveState}`}>
              {saveState === "edited" ? "Edited" : saveState === "saved" ? "Saved" : ""}
            </span>
          </span>
        </div>
        <div className="chrome-actions">
          <button type="button" onClick={handleNew}>New</button>
          <button type="button" onClick={handleOpen}>Open</button>
          <button type="button" onClick={() => save(false)}>Save</button>
          <button type="button" onClick={handlePrint}>Print</button>
          <button type="button" onClick={handleCheckUpdates} disabled={checkingUpdate}>
            {checkingUpdate ? "Checking…" : "Updates"}
          </button>
          <div className="mode-switch" role="group" aria-label="View mode">
            <button type="button" className={view === "live" ? "is-active" : ""} onClick={() => setView("live")}>Live</button>
            <button type="button" className={view === "source" ? "is-active" : ""} onClick={() => setView("source")}>Source</button>
            <button type="button" className={view === "reading" ? "is-active" : ""} onClick={() => setView("reading")}>Reading</button>
          </div>
          <div className="theme-switch" role="group" aria-label="Theme">
            {THEMES.map((name) => (
              <button
                key={name}
                type="button"
                className={`theme-swatch theme-swatch-${name}${theme === name ? " is-active" : ""}`}
                onClick={() => setTheme(name)}
                title={name[0].toUpperCase() + name.slice(1)}
                aria-label={`${name} theme`}
                aria-pressed={theme === name}
              />
            ))}
          </div>
        </div>
      </header>

      {diskBanner ? (
        <div className="banner">
          File changed on disk
          <button type="button" onClick={() => path && loadPath(path, true)}>Reload</button>
          <button type="button" onClick={() => setDiskBanner(false)}>Keep mine</button>
        </div>
      ) : null}

      <main className="workspace">
        {showStart ? (
          <section className="start">
            <h1>Open a Markdown file</h1>
            <p>Double-click a `.md` file in Finder, drop one here, or pick from recent files.</p>
            <button type="button" className="start-open" onClick={handleOpen}>Open…</button>
            <button type="button" className="start-update" onClick={handleCheckUpdates} disabled={checkingUpdate}>
              {checkingUpdate ? "Checking GitHub…" : "Check for updates"}
            </button>
            {recentNames.length ? (
              <div className="recent">
                <div className="pane-label">Recent</div>
                {recentNames.map((item) => (
                  <button key={item.path} type="button" className="recent-item" onClick={() => loadPath(item.path, true)}>
                    {item.name}
                    <span>{item.path}</span>
                  </button>
                ))}
                <button type="button" onClick={() => clearRecent()}>Clear recent</button>
              </div>
            ) : null}
          </section>
        ) : view === "reading" ? (
          <ReadingView text={text} filePath={path} onOpenNote={openNote} />
        ) : (
          <div className="page editor-page">
            <MarkdownEditor
              key={docId}
              initialText={text}
              mode={view === "source" ? "source" : "live"}
              onChange={markDirty}
              onOpenNote={openNote}
            />
          </div>
        )}
      </main>
    </div>
  );
}
