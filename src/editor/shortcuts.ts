import { EditorSelection, type StateCommand } from "@codemirror/state";
import { keymap } from "@codemirror/view";

function wrapSelection(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const wrapped = selected.startsWith(marker) && selected.endsWith(marker)
        ? selected.slice(marker.length, selected.length - marker.length)
        : `${marker}${selected || "text"}${marker}`;
      return {
        changes: { from: range.from, to: range.to, insert: wrapped },
        range: EditorSelection.range(range.from, range.from + wrapped.length),
      };
    });
    dispatch(state.update(changes, { userEvent: "input" }));
    return true;
  };
}

function wrapLink(): StateCommand {
  return ({ state, dispatch }) => {
    const url = window.prompt("Link URL", "https://");
    if (!url) {
      return true;
    }
    const changes = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to) || "link";
      const insert = `[${selected}](${url})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    });
    dispatch(state.update(changes, { userEvent: "input" }));
    return true;
  };
}

export const markdownShortcuts = keymap.of([
  { key: "Mod-b", run: wrapSelection("**") },
  { key: "Mod-i", run: wrapSelection("*") },
  { key: "Mod-k", run: wrapLink() },
]);
