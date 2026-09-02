import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { livePreview, livePreviewTheme, wikiClickHandler } from "./livePreview";
import { markdownShortcuts } from "./shortcuts";

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--mono)" },
  { tag: tags.meta, opacity: 0.6 },
]);

type MarkdownEditorProps = {
  initialText: string;
  mode: "live" | "source";
  onChange: (text: string) => void;
  onOpenNote?: (target: string) => void;
};

export default function MarkdownEditor({ initialText, mode, onChange, onOpenNote }: MarkdownEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewConf = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onOpenNoteRef = useRef(onOpenNote);
  const modeRef = useRef(mode);
  onChangeRef.current = onChange;
  onOpenNoteRef.current = onOpenNote;
  modeRef.current = mode;

  useEffect(() => {
    if (!parentRef.current) {
      return;
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        extensions: [
          history(),
          markdown(),
          lineNumbers(),
          placeholder("Start writing Markdown…"),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdownShortcuts,
          wikiClickHandler((target) => onOpenNoteRef.current?.(target), () => modeRef.current),
          syntaxHighlighting(markdownHighlight),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              background: "transparent",
              color: "var(--ink)",
              fontSize: "16px",
            },
            ".cm-scroller": {
              fontFamily: "var(--serif)",
              lineHeight: "1.65",
            },
            ".cm-content": { padding: "28px 8px 48px" },
            ".cm-gutters": {
              background: "transparent",
              border: "none",
              color: "var(--muted)",
            },
            "&.cm-focused": { outline: "none" },
          }),
          previewConf.current.of(mode === "live" ? [livePreview, livePreviewTheme] : []),
        ],
      }),
      parent: parentRef.current,
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Recreate only when a new document is loaded (parent should set key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: previewConf.current.reconfigure(
        mode === "live" ? [livePreview, livePreviewTheme] : [],
      ),
    });
    parentRef.current?.classList.toggle("mode-source", mode === "source");
  }, [mode]);

  return <div ref={parentRef} className={`cm-host mode-${mode}`} />;
}
