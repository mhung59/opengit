//! Native command boundary of the Git edition. Tooling cannot activate dormant IDE services.
pub fn command_available(command: &str) -> bool {
    if command == "window_open_remote" {
        return false;
    }
    if command.starts_with("plugin:") {
        return true; // Tauri's native dialog, window and opener adapters.
    }
    if [
        "vcs_",
        "term_",
        "fs_",
        "doc_",
        "history_",
        "settings_",
        "window_",
        "window_group_",
        "workspace_",
        "clipboard_",
        "search_",
        "menu_",
    ]
    .iter()
    .any(|p| command.starts_with(p))
    {
        return true;
    }
    matches!(
        command,
        "app_info"
            | "proxy_check_connection"
            | "recent_projects"
            | "remove_recent_project"
            | "open_project"
            | "close_project"
            | "light_edit_open"
            | "project_current"
            | "project_rename"
            | "project_roots"
            | "languages"
            | "project_trust_status"
            | "project_trust_list"
            | "project_trust_set"
            | "project_trust_remove_location"
            | "cancel_request"
            | "cancel_task"
            | "log_frontend"
            | "system_font_families"
            | "user_font_data"
            | "find_files"
            | "mark_recent"
            | "remove_recent"
            | "recent_files"
            | "index_status"
            | "ssh_askpass_answer"
            | "git_credentials"
            | "git_credential_forget"
            | "app_quit"
            | "app_cancel_quit"
            | "app_log_location"
            | "app_build_info"
            | "app_metrics"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_git_editor_and_native_shell_without_ide_services() {
        for command in [
            "vcs_commit",
            "vcs_log",
            "doc_open",
            "fs_read_dir",
            "window_open",
            "find_files",
            "term_spawn",
            "term_write",
            "term_resize",
            "term_kill",
        ] {
            assert!(command_available(command), "{command}");
        }
        for command in [
            "agent_create",
            "db_connect",
            "plugin_list",
            "analysis_run",
            "lsp_start",
            "run_start",
            "remote_connect",
            "notebook_execute",
        ] {
            assert!(!command_available(command), "{command}");
        }
    }
}
