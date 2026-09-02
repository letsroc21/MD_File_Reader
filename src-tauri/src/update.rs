use serde::Deserialize;
use tauri::webview::WebviewWindow;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const GIT_SHA: &str = env!("GIT_SHA");
const GIT_DIRTY: &str = env!("GIT_DIRTY");
const GIT_REMOTE: &str = env!("GIT_REMOTE");

#[derive(Deserialize)]
struct GithubCommit {
    sha: String,
    commit: GithubCommitBody,
}

#[derive(Deserialize)]
struct GithubCommitBody {
    message: String,
}

#[derive(Deserialize)]
struct GithubCompare {
    status: String,
    ahead_by: u32,
    behind_by: u32,
}

pub fn github_repo(remote: &str) -> Option<(String, String)> {
    let trimmed = remote.trim().trim_end_matches(".git");
    let path = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        rest
    } else {
        return None;
    };
    let mut parts = path.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn short_sha(sha: &str) -> &str {
    if sha.len() >= 7 {
        &sha[..7]
    } else {
        sha
    }
}

fn first_line(message: &str) -> &str {
    message.lines().next().unwrap_or(message).trim()
}

fn open_url(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}

fn is_dirty() -> bool {
    GIT_DIRTY == "1"
}

async fn github_get<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .header("User-Agent", "MD-File-Reader")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub returned {status}"));
    }
    response.json::<T>().await.map_err(|err| err.to_string())
}

fn show_message(app: &AppHandle, window: &WebviewWindow, message: impl Into<String>) {
    app.dialog()
        .message(message.into())
        .kind(MessageDialogKind::Info)
        .title("MD File Reader")
        .parent(window)
        .blocking_show();
}

fn confirm_open(
    app: &AppHandle,
    window: &WebviewWindow,
    message: impl Into<String>,
) -> bool {
    let result = app
        .dialog()
        .message(message.into())
        .kind(MessageDialogKind::Info)
        .title("MD File Reader")
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open GitHub".into(),
            "Later".into(),
        ))
        .blocking_show_with_result();
    match result {
        MessageDialogResult::Ok => true,
        MessageDialogResult::Custom(label) if label == "Open GitHub" => true,
        _ => false,
    }
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let Some((owner, repo)) = github_repo(GIT_REMOTE) else {
        show_message(
            &app,
            &window,
            format!(
                "This build is {VERSION} ({sha}). It doesn’t know which GitHub repo to check.",
                sha = short_sha(GIT_SHA)
            ),
        );
        return Ok(());
    };

    let latest_url = format!("https://api.github.com/repos/{owner}/{repo}/commits/main");
    let latest = github_get::<GithubCommit>(&latest_url).await?;
    let local = GIT_SHA;
    let remote = latest.sha.as_str();
    let repo_url = format!("https://github.com/{owner}/{repo}");
    let compare_url = format!("https://github.com/{owner}/{repo}/compare/{local}...{remote}");

    if local == remote {
        let extra = if is_dirty() {
            " This install also includes local changes that were not committed when it was built."
        } else {
            ""
        };
        show_message(
            &app,
            &window,
            format!(
                "You’re up to date with GitHub.\n\nThis install is {VERSION} ({sha}).{extra}\n\nTo pick up local code changes, rebuild and copy the app to /Applications.",
                sha = short_sha(local)
            ),
        );
        return Ok(());
    }

    let compare_api = format!(
        "https://api.github.com/repos/{owner}/{repo}/compare/{local}...{remote}"
    );
    let compare = github_get::<GithubCompare>(&compare_api).await.ok();
    let behind = compare
        .as_ref()
        .map(|item| item.behind_by > 0 || item.status == "behind" || item.status == "diverged")
        .unwrap_or(true);
    let ahead = compare
        .as_ref()
        .map(|item| item.ahead_by > 0)
        .unwrap_or(is_dirty());

    if behind {
        let summary = first_line(&latest.commit.message);
        let mut message = format!(
            "GitHub has a newer commit than this install.\n\nThis install: {VERSION} ({local})\nGitHub: {remote} — {summary}\n\nThe Dock app does not update itself. Pull, rebuild, and copy the new .app to /Applications.",
            local = short_sha(local),
            remote = short_sha(remote),
        );
        if ahead {
            message.push_str("\n\nThis install also has commits that are not on GitHub yet.");
        }
        if confirm_open(&app, &window, message) {
            open_url(&compare_url);
        }
        return Ok(());
    }

    if confirm_open(
        &app,
        &window,
        format!(
            "This install is ahead of GitHub ({local} vs {remote}).\n\nPush if you want GitHub to match, or open the repo.",
            local = short_sha(local),
            remote = short_sha(remote),
        ),
    ) {
        open_url(&repo_url);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::github_repo;

    #[test]
    fn parses_https_and_ssh_remotes() {
        assert_eq!(
            github_repo("https://github.com/letsroc21/MD_File_Reader.git"),
            Some(("letsroc21".into(), "MD_File_Reader".into()))
        );
        assert_eq!(
            github_repo("git@github.com:letsroc21/MD_File_Reader.git"),
            Some(("letsroc21".into(), "MD_File_Reader".into()))
        );
    }
}
