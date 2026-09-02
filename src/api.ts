import { invoke } from "@tauri-apps/api/core";

export type DocumentFile = {
  path: string;
  text: string;
  lineEnding: "lf" | "crlf" | string;
  trailingNewline: boolean;
};

export async function registerWindow() {
  return invoke<string[]>("register_window");
}

export async function takePendingFiles() {
  return invoke<string[]>("take_pending_files");
}

export async function setWindowOccupied(occupied: boolean) {
  return invoke<void>("set_window_occupied", { occupied });
}

export async function setWindowPath(path: string | null) {
  return invoke<void>("set_window_path", { path });
}

export async function readDocument(path: string) {
  return invoke<DocumentFile>("read_document", { path });
}

export async function writeDocument(payload: DocumentFile) {
  return invoke<void>("write_document", { payload });
}

export async function pickFile() {
  return invoke<string | null>("pick_file");
}

export async function pickSavePath(defaultName?: string) {
  return invoke<string | null>("pick_save_path", { defaultName });
}

export async function openInNewWindow(path: string) {
  return invoke<void>("open_in_new_window", { path });
}

export async function openBlankWindow() {
  return invoke<void>("open_blank_window");
}

export async function setWindowDirty(dirty: boolean) {
  return invoke<void>("set_window_dirty", { dirty });
}

export async function unsavedDialog(name: string) {
  return invoke<"save" | "discard" | "cancel">("unsaved_dialog", { name });
}

export async function cancelQuit() {
  return invoke<void>("cancel_quit");
}

export async function printDocument() {
  return invoke<void>("print_document");
}

export async function listRecent() {
  return invoke<string[]>("list_recent");
}

export async function clearRecent() {
  return invoke<void>("clear_recent");
}

export async function watchFile(path: string) {
  return invoke<void>("watch_file", { path });
}

export async function setNativeTheme(night: boolean) {
  return invoke<void>("set_native_theme", { night });
}
