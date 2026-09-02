import { syntaxTree } from "@codemirror/language";
import { type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget) {
    return this.checked === other.checked && this.from === other.from;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "md-task";
    box.tabIndex = -1;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: this.checked ? "[ ]" : "[x]",
        },
      });
    });
    return box;
  }

  ignoreEvent() {
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const line = view.state.doc.lineAt(view.state.selection.main.head);

  const add = (from: number, to: number, deco: Decoration) => {
    if (from < to) {
      ranges.push(deco.range(from, to));
    }
  };

  const hide = (from: number, to: number) => {
    if (from >= line.from && to <= line.to) {
      return;
    }
    add(from, to, Decoration.mark({ class: "md-mark" }));
  };

  const first = view.state.doc.line(1).text.trim();
  if (first === "---" && view.state.doc.lines > 1) {
    for (let i = 2; i <= view.state.doc.lines; i += 1) {
      if (view.state.doc.line(i).text.trim() === "---") {
        add(0, view.state.doc.line(i).to, Decoration.mark({ class: "md-frontmatter" }));
        break;
      }
    }
  }

  syntaxTree(view.state).iterate({
    enter(node) {
      const name = node.name;
      if (name.startsWith("ATXHeading")) {
        const level = name.replace("ATXHeading", "") || "1";
        add(node.from, node.to, Decoration.mark({ class: `md-h md-h${level}` }));
      } else if (
        name === "HeaderMark"
        || name === "EmphasisMark"
        || name === "CodeMark"
        || name === "QuoteMark"
        || name === "LinkMark"
      ) {
        hide(node.from, node.to);
      } else if (name === "StrongEmphasis") {
        add(node.from, node.to, Decoration.mark({ class: "md-strong" }));
      } else if (name === "Emphasis") {
        add(node.from, node.to, Decoration.mark({ class: "md-em" }));
      } else if (name === "InlineCode" || name === "FencedCode") {
        add(node.from, node.to, Decoration.mark({ class: "md-code" }));
      } else if (name === "Blockquote") {
        add(node.from, node.to, Decoration.mark({ class: "md-quote" }));
      } else if (name === "URL") {
        add(node.from, node.to, Decoration.mark({ class: "md-link" }));
      } else if (name === "TaskMarker") {
        const mark = view.state.doc.sliceString(node.from, node.to);
        const checked = /\[[xX]\]/.test(mark);
        add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new CheckboxWidget(checked, node.from, node.to),
          }),
        );
      }
    },
  });

  return Decoration.set(ranges, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

export const livePreviewTheme = EditorView.theme({
  ".md-mark": { opacity: "0.28" },
  ".md-h": { fontFamily: "var(--serif)", fontWeight: "700", letterSpacing: "-0.02em" },
  ".md-h1": { fontSize: "1.9em" },
  ".md-h2": { fontSize: "1.4em" },
  ".md-h3": { fontSize: "1.18em" },
  ".md-strong": { fontWeight: "700" },
  ".md-em": { fontStyle: "italic" },
  ".md-code": { fontFamily: "var(--mono)", fontSize: "0.92em", background: "var(--accent-soft)" },
  ".md-quote": { color: "var(--quote)" },
  ".md-link": { color: "var(--accent)", textDecoration: "underline" },
  ".md-frontmatter": { opacity: "0.55", fontFamily: "var(--mono)", fontSize: "12px" },
  ".md-task": { marginRight: "6px", verticalAlign: "middle" },
});
