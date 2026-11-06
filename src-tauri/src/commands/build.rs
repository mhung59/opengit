//! IPC commands of `ide_host::ops::build` (the shared implementation).

use crate::state::AppState;
use ide_build::BuildModel;
use ide_core::IdeResult;
use tauri::{State, Window};

/// Maven and Gradle projects of the window's project, from the build files plus the last sync.
#[tauri::command]
#[specta::specta]
pub async fn build_model(window: Window, state: State<'_, AppState>) -> IdeResult<BuildModel> {
    ide_host::ops::build::build_model(&state.host, window.label()).await
}
