use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::webview::WebviewWindow;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Theme, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

mod update;

const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];
const RECENT_LIMIT: usize = 15;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub text: String,
    pub line_ending: String,
    pub trailing_newline: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePayload {
    pub path: String,
    pub text: String,
    pub line_ending: String,
    pub trailing_newline: bool,
}

struct AppState {
    pending: Mutex<Vec<PathBuf>>,
    dirty: Mutex<HashSet<String>>,
    occupied: Mutex<HashSet<String>>,
    ready: Mutex<HashSet<String>>,
    open_paths: Mutex<HashMap<String, String>>,
    quitting: Mutex<bool>,
    route: Mutex<()>,
    last_write: Mutex<HashMap<PathBuf, Instant>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            dirty: Mutex::new(HashSet::new()),
            occupied: Mutex::new(HashSet::new()),
            ready: Mutex::new(HashSet::new()),
            open_paths: Mutex::new(HashMap::new()),
            quitting: Mutex::new(false),
            route: Mutex::new(()),
            last_write: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
        }
    }
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| MARKDOWN_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn detect_line_ending(raw: &str) -> String {
    if raw.contains("\r\n") {
        "crlf".into()
    } else {
        "lf".into()
    }
}

fn encode_text(text: &str, line_ending: &str, trailing_newline: bool) -> String {
    let mut normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let has_trailing = normalized.ends_with('\n');
    if trailing_newline && !has_trailing {
        normalized.push('\n');
    } else if !trailing_newline && has_trailing {
        while normalized.ends_with('\n') {
            normalized.pop();
        }
    }
    if line_ending == "crlf" {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

fn decode_text(raw: &str) -> (String, bool) {
    let trailing_newline = raw.ends_with('\n');
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    (text, trailing_newline)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("File has no parent directory")?;
    let tmp = dir.join(format!(
        ".{}.mdreader-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));

    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|err| err.to_string())?;
        file.write_all(bytes).map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
    }

    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }

    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        err.to_string()
    })?;

    if let Ok(dir_file) = File::open(dir) {
        let _ = dir_file.sync_all();
    }

    Ok(())
}

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("recent.json"))
}

fn load_recent(app: &AppHandle) -> Vec<String> {
    let Ok(path) = recent_file(app) else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_recent(app: &AppHandle, items: &[String]) -> Result<(), String> {
    let path = recent_file(app)?;
    fs::write(
        path,
        serde_json::to_vec_pretty(items).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

fn window_label_for(path: &Path) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("doc-{:x}", hasher.finish())
}

fn allow_path(app: &AppHandle, path: &Path) {
    let _ = app.asset_protocol_scope().allow_file(path);
    if let Some(parent) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, false);
    }
}

fn window_for_path(app: &AppHandle, path: &Path) -> Option<WebviewWindow> {
    let key = path.to_string_lossy().to_string();
    let state = app.state::<AppState>();
    let mapped = match state.open_paths.lock() {
        Ok(map) => map.get(&key).cloned(),
        Err(_) => None,
    }?;
    drop(state);
    app.get_webview_window(&mapped)
}

fn remember_path(app: &AppHandle, label: &str, path: &Path) {
    let key = path.to_string_lossy().to_string();
    if let Ok(mut open_paths) = app.state::<AppState>().open_paths.lock() {
        open_paths.retain(|_, existing| existing != label);
        open_paths.insert(key, label.to_string());
    }
}

fn create_document_window(app: &AppHandle, path: &Path) -> Result<(), String> {
    if let Some(existing) = window_for_path(app, path) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let mut label = window_label_for(path);
    if app.get_webview_window(&label).is_some() {
        label = format!(
            "{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
    }

    allow_path(app, path);
    let path_text = path.to_string_lossy();
    let encoded = urlencoding::encode(&path_text);
    let title = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("MD File Reader");

    WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?file={encoded}").into()),
    )
    .title(title)
    .inner_size(1180.0, 840.0)
    .min_inner_size(720.0, 520.0)
    .hidden_title(true)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .traffic_light_position(LogicalPosition::new(16.0, 18.0))
    .center()
    .build()
    .map_err(|err| err.to_string())?;

    remember_path(app, &label, path);
    if let Ok(mut occupied) = app.state::<AppState>().occupied.lock() {
        occupied.insert(label);
    }

    Ok(())
}

fn with_ext_normalized(path: PathBuf) -> String {
    let text = path.to_string_lossy().to_string();
    match Path::new(&text).extension().and_then(|ext| ext.to_str()) {
        Some("md" | "markdown" | "mdown" | "mkd" | "txt") => text,
        Some(_) | None => format!("{text}.md"),
    }
}

fn find_ready_blank(app: &AppHandle) -> Option<WebviewWindow> {
    let state = app.state::<AppState>();
    let occupied = state.occupied.lock().ok()?;
    let ready = state.ready.lock().ok()?;
    app.webview_windows().into_iter().find_map(|(label, window)| {
        if ready.contains(&label) && !occupied.contains(&label) {
            Some(window)
        } else {
            None
        }
    })
}

fn deliver_files(app: &AppHandle, files: Vec<PathBuf>) {
    if files.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let _route = state.route.lock().unwrap();
    let mut remaining = Vec::new();
    for path in files {
        if let Some(existing) = window_for_path(app, &path) {
            let _ = existing.set_focus();
            continue;
        }
        remaining.push(path);
    }
    if remaining.is_empty() {
        return;
    }

    if let Some(blank) = find_ready_blank(app) {
        let mut iter = remaining.into_iter();
        if let Some(first) = iter.next() {
            let label = blank.label().to_string();
            if let Ok(mut occupied) = app.state::<AppState>().occupied.lock() {
                occupied.insert(label.clone());
            }
            remember_path(app, &label, &first);
            let _ = app.emit_to(
                label.as_str(),
                "open-file",
                first.to_string_lossy().to_string(),
            );
        }
        for extra in iter {
            let _ = create_document_window(app, &extra);
        }
        return;
    }

    if app.webview_windows().is_empty() {
        if let Ok(mut pending) = app.state::<AppState>().pending.lock() {
            pending.extend(remaining);
        }
        return;
    }

    // Windows exist but none are ready-and-blank (launch race, or all occupied).
    let any_unready_blank = {
        let state = app.state::<AppState>();
        let occupied = state.occupied.lock().unwrap();
        let ready = state.ready.lock().unwrap();
        app.webview_windows()
            .keys()
            .any(|label| !ready.contains(label) && !occupied.contains(label))
    };

    if any_unready_blank {
        if let Ok(mut pending) = app.state::<AppState>().pending.lock() {
            pending.extend(remaining);
        }
        return;
    }

    for path in remaining {
        let _ = create_document_window(app, &path);
    }
}

fn queue_or_open(app: &AppHandle, files: Vec<PathBuf>) {
    let files: Vec<PathBuf> = files.into_iter().filter(|path| is_supported(path)).collect();
    deliver_files(app, files);
}

fn ensure_watcher(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut watcher_slot = state.watcher.lock().unwrap();
    if watcher_slot.is_some() {
        return;
    }

    let handle = app.clone();
    let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else {
            return;
        };
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let state = handle.state::<AppState>();
        for path in event.paths {
            let ignore = state
                .last_write
                .lock()
                .ok()
                .and_then(|map| map.get(&path).copied())
                .map(|at| at.elapsed() < Duration::from_millis(900))
                .unwrap_or(false);
            if ignore {
                continue;
            }
            let _ = handle.emit("file-changed", path.to_string_lossy().to_string());
        }
    })
    .ok();

    *watcher_slot = watcher;
}

fn add_recent_path(app: &AppHandle, path: String) -> Result<(), String> {
    let mut items = load_recent(app);
    items.retain(|item| item != &path);
    items.insert(0, path);
    items.truncate(RECENT_LIMIT);
    save_recent(app, &items)?;
    let _ = app.emit("recent-changed", items);
    Ok(())
}

fn has_dirty(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .dirty
        .lock()
        .map(|set| !set.is_empty())
        .unwrap_or(false)
}

fn forget_window(app: &AppHandle, label: &str) {
    if let Ok(mut dirty) = app.state::<AppState>().dirty.lock() {
        dirty.remove(label);
    }
    if let Ok(mut occupied) = app.state::<AppState>().occupied.lock() {
        occupied.remove(label);
    }
    if let Ok(mut ready) = app.state::<AppState>().ready.lock() {
        ready.remove(label);
    }
    if let Ok(mut open_paths) = app.state::<AppState>().open_paths.lock() {
        open_paths.retain(|_, existing| existing != label);
    }
}

#[tauri::command]
fn register_window(app: AppHandle, window: WebviewWindow) -> Vec<String> {
    let label = window.label().to_string();
    if let Ok(mut ready) = app.state::<AppState>().ready.lock() {
        ready.insert(label.clone());
    }

    let state = app.state::<AppState>();
    let occupied = state
        .occupied
        .lock()
        .map(|set| set.contains(&label))
        .unwrap_or(false);
    if occupied {
        return Vec::new();
    }

    let files: Vec<PathBuf> = {
        let mut pending = state.pending.lock().unwrap();
        pending.drain(..).collect()
    };
    if files.is_empty() {
        return Vec::new();
    }

    if let Ok(mut occupied_set) = state.occupied.lock() {
        occupied_set.insert(label.clone());
    }

    let mut iter = files.into_iter();
    let first = iter.next();
    if let Some(path) = &first {
        remember_path(&app, &label, path);
    }
    for extra in iter {
        let _ = create_document_window(&app, &extra);
    }
    first
        .map(|path| path.to_string_lossy().to_string())
        .into_iter()
        .collect()
}

#[tauri::command]
fn set_window_path(app: AppHandle, window: WebviewWindow, path: Option<String>) {
    let label = window.label().to_string();
    let state = app.state::<AppState>();
    let mut open_paths = state.open_paths.lock().unwrap();
    open_paths.retain(|_, existing| existing != &label);
    if let Some(path) = path {
        open_paths.insert(path, label);
    }
}

#[tauri::command]
fn set_window_occupied(window: WebviewWindow, occupied: bool) {
    let label = window.label().to_string();
    let app = window.app_handle();
    let state = app.state::<AppState>();
    let mut set = state.occupied.lock().unwrap();
    if occupied {
        set.insert(label);
    } else {
        set.remove(&label);
    }
}

#[tauri::command]
fn take_pending_files(app: AppHandle, window: WebviewWindow) -> Vec<String> {
    register_window(app, window)
}

#[tauri::command]
fn read_document(app: AppHandle, path: String) -> Result<Document, String> {
    let path = PathBuf::from(&path);
    if !is_supported(&path) {
        return Err("Unsupported file type".into());
    }
    let raw = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let line_ending = detect_line_ending(&raw);
    let (text, trailing_newline) = decode_text(&raw);
    allow_path(&app, &path);
    add_recent_path(&app, path.to_string_lossy().to_string())?;
    Ok(Document {
        path: path.to_string_lossy().to_string(),
        text,
        line_ending,
        trailing_newline,
    })
}

#[tauri::command]
fn write_document(app: AppHandle, payload: SavePayload) -> Result<(), String> {
    let path = PathBuf::from(&payload.path);
    if !is_supported(&path) {
        return Err("Unsupported file type".into());
    }
    let encoded = encode_text(&payload.text, &payload.line_ending, payload.trailing_newline);
    atomic_write(&path, encoded.as_bytes())?;
    if let Ok(mut last_write) = app.state::<AppState>().last_write.lock() {
        last_write.insert(path, Instant::now());
    }
    add_recent_path(&app, payload.path)?;
    Ok(())
}

#[tauri::command]
async fn pick_file(app: AppHandle, window: WebviewWindow) -> Option<String> {
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .add_filter("Text", &["txt"])
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_save_path(app: AppHandle, window: WebviewWindow, default_name: Option<String>) -> Option<String> {
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(default_name.as_deref().unwrap_or("Untitled.md"))
        .blocking_save_file()
        .and_then(|file| file.into_path().ok())
        .map(with_ext_normalized)
}

#[tauri::command]
fn open_blank_window(app: AppHandle) -> Result<(), String> {
    let label = format!(
        "untitled-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Untitled")
        .inner_size(1180.0, 840.0)
        .min_inner_size(720.0, 520.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(LogicalPosition::new(16.0, 18.0))
        .center()
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_in_new_window(app: AppHandle, path: String) -> Result<(), String> {
    create_document_window(&app, Path::new(&path))
}

#[tauri::command]
fn set_window_dirty(app: AppHandle, window: WebviewWindow, dirty: bool) {
    let label = window.label().to_string();
    let state = app.state::<AppState>();
    let mut set = state.dirty.lock().unwrap();
    if dirty {
        set.insert(label);
    } else {
        set.remove(&label);
    }
}

#[tauri::command]
async fn unsaved_dialog(app: AppHandle, window: WebviewWindow, name: String) -> String {
    let result = app
        .dialog()
        .message(format!("Do you want to save the changes you made to {name}?"))
        .kind(MessageDialogKind::Warning)
        .title("MD File Reader")
        .parent(&window)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "Save".into(),
            "Don't Save".into(),
            "Cancel".into(),
        ))
        .blocking_show_with_result();

    match result {
        MessageDialogResult::Yes => "save".into(),
        MessageDialogResult::No => "discard".into(),
        MessageDialogResult::Custom(label) if label == "Save" => "save".into(),
        MessageDialogResult::Custom(label) if label == "Don't Save" => "discard".into(),
        _ => "cancel".into(),
    }
}

#[tauri::command]
fn cancel_quit(app: AppHandle) {
    if let Ok(mut quitting) = app.state::<AppState>().quitting.lock() {
        *quitting = false;
    }
}

#[tauri::command]
fn print_document(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|err| err.to_string())
}

#[tauri::command]
fn list_recent(app: AppHandle) -> Vec<String> {
    load_recent(&app)
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .collect()
}

#[tauri::command]
fn clear_recent(app: AppHandle) -> Result<(), String> {
    save_recent(&app, &[])?;
    let _ = app.emit("recent-changed", Vec::<String>::new());
    Ok(())
}

fn note_stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for ext in MARKDOWN_EXTS {
        let suffix = format!(".{ext}");
        if lower.ends_with(&suffix) {
            return name[..name.len() - suffix.len()].to_string();
        }
    }
    name.to_string()
}

fn resolve_note_in_dir(dir: &Path, target: &str) -> Option<PathBuf> {
    let mut names = vec![target.to_string()];
    let lower = target.to_ascii_lowercase();
    if !MARKDOWN_EXTS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
    {
        names.push(format!("{target}.md"));
        names.push(format!("{target}.markdown"));
    }
    for name in &names {
        let path = dir.join(name);
        if path.is_file() && is_supported(&path) {
            return Some(path);
        }
    }
    let wanted = note_stem(target).to_ascii_lowercase();
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_supported(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if note_stem(name).to_ascii_lowercase() == wanted {
            return Some(path);
        }
    }
    None
}

#[tauri::command]
fn resolve_note(from: Option<String>, target: String) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    let direct = PathBuf::from(trimmed);
    if direct.is_absolute() && direct.is_file() && is_supported(&direct) {
        return Some(direct.to_string_lossy().to_string());
    }
    let from = PathBuf::from(from.as_deref()?);
    let dir = from.parent()?;
    resolve_note_in_dir(dir, trimmed).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn watch_file(app: AppHandle, path: String) -> Result<(), String> {
    ensure_watcher(&app);
    let path = PathBuf::from(path);
    let state = app.state::<AppState>();
    if let Some(watcher) = state.watcher.lock().unwrap().as_mut() {
        watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_native_theme(app: AppHandle, night: bool) {
    for (_, window) in app.webview_windows() {
        let _ = window.set_theme(Some(if night { Theme::Dark } else { Theme::Light }));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = argv
                .into_iter()
                .skip(1)
                .filter(|arg| !arg.starts_with('-'))
                .map(PathBuf::from)
                .collect();
            queue_or_open(app, files);
        }))
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            register_window,
            take_pending_files,
            set_window_occupied,
            set_window_path,
            read_document,
            write_document,
            pick_file,
            pick_save_path,
            open_in_new_window,
            open_blank_window,
            set_window_dirty,
            unsaved_dialog,
            cancel_quit,
            print_document,
            list_recent,
            clear_recent,
            watch_file,
            resolve_note,
            set_native_theme,
            update::check_for_update
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                let app = window.app_handle().clone();
                forget_window(&app, &label);
                let quitting = app
                    .state::<AppState>()
                    .quitting
                    .lock()
                    .map(|flag| *flag)
                    .unwrap_or(false);
                if quitting && !has_dirty(&app) {
                    app.exit(0);
                }
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
            if labels.is_empty() {
                return;
            }
            api.prevent_exit();
            if let Ok(mut quitting) = app.state::<AppState>().quitting.lock() {
                *quitting = true;
            }
            for label in labels {
                let _ = app.emit_to(label.as_str(), "quit-requested", ());
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => {
            let files = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect();
            queue_or_open(app, files);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{decode_text, encode_text};
    use std::fs;

    #[test]
    fn roundtrip_preserves_crlf_and_trailing_newline() {
        let original = "---\ntitle: x\n---\n\n- [ ] a\n";
        let encoded = encode_text(original, "crlf", true);
        assert!(encoded.contains("\r\n"));
        let (text, trailing) = decode_text(&encoded);
        let again = encode_text(&text, "crlf", trailing);
        assert_eq!(encoded, again);
    }

    #[test]
    fn atomic_write_replaces_file() {
        let dir = std::env::temp_dir().join("md-reader-test");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("note.md");
        fs::write(&path, "old").unwrap();
        super::atomic_write(&path, b"new content\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new content\n");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn resolve_note_finds_md_in_same_folder() {
        let dir = std::env::temp_dir().join("md-reader-wiki");
        let _ = fs::create_dir_all(&dir);
        let note = dir.join("Welcome.md");
        fs::write(&note, "# hi\n").unwrap();
        let found = super::resolve_note_in_dir(&dir, "welcome").unwrap();
        assert!(found.is_file());
        assert_eq!(
            found.file_stem().unwrap().to_string_lossy().to_ascii_lowercase(),
            "welcome"
        );
        let _ = fs::remove_file(&note);
    }
}
