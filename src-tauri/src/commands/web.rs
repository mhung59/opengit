//! Web browsers: the built-in server's URLs and launching browsers.

use crate::state::AppState;
use ide_core::{IdeResult, IpcPath};
use ide_web::Browser;
use tauri::{State, Window};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

/// The browsers installed on this machine.
#[tauri::command]
#[specta::specta]
pub async fn web_browsers() -> IdeResult<Vec<Browser>> {
    blocking(|| Ok(ide_web::installed())).await
}

/// The built-in server's URL for `path` (started on first use).
#[tauri::command]
#[specta::specta]
pub async fn web_url(window: Window, state: State<'_, AppState>, path: IpcPath) -> IdeResult<String> {
    let root = state.project(window.label()).ok().map(|p| p.root.clone());
    state.web.url_for(root.as_deref(), &path).await
}

/// Opens `url` in `browser` (an id from `web_browsers`), or the default browser.
#[tauri::command]
#[specta::specta]
pub async fn web_open(url: String, browser: Option<String>) -> IdeResult<()> {
    blocking(move || ide_web::open(&url, browser.as_deref())).await
}
