//! IPC commands of `ide_host::ops::tools` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, RequestId};
use ide_sdk::Sdk;
use ide_tools::InstallEvent;
use ide_tools::jdk::{JdkReleases, JdkVendor};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// JDK distributions Download JDK offers.
#[tauri::command]
#[specta::specta]
pub fn jdk_download_vendors(state: State<'_, AppState>) -> Vec<JdkVendor> {
    ide_host::ops::tools::jdk_download_vendors(&state.host, "")
}

/// Java versions `vendor` publishes; cancellable with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn jdk_download_releases(
    window: Window,
    state: State<'_, AppState>,
    vendor: String,
    request: RequestId,
) -> IdeResult<JdkReleases> {
    ide_host::ops::tools::jdk_download_releases(&state.host, window.label(), vendor, request).await
}

/// Where Download JDK puts JDKs unless told otherwise.
#[tauri::command]
#[specta::specta]
pub fn jdk_download_location(state: State<'_, AppState>) -> IdeResult<ide_core::IpcPath> {
    ide_host::ops::tools::jdk_download_location(&state.host, "")
}

/// Downloads the latest `vendor` JDK of Java `version` into `location` (default:
/// [`jdk_download_location`]), streaming progress through `on_event`; cancellable
/// with `cancel_request(request)`. The JDK is then detected like an installed one,
/// and language servers waiting for a JDK (jdtls) start on it.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn jdk_download(
    window: Window,
    state: State<'_, AppState>,
    vendor: String,
    version: u32,
    location: Option<PathBuf>,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<Sdk> {
    ide_host::ops::tools::jdk_download(
        &state.host,
        window.label(),
        vendor,
        version,
        location,
        request,
        crate::commands::sender(on_event),
    )
    .await
}
