//! Git workspaces preserve documents and repositories without starting IDE services.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn documents_git_and_file_navigation_work_without_indexing_or_language_servers() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    ide_vcs::init(&root).unwrap();
    std::fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
    let local = tmp.path().join("local");
    let host = Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: local.clone(),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    #[cfg(feature = "project-trust")]
    {
        assert!(!host.open_project("main", &root).unwrap().is_trusted());
        assert!(host.authorize_command("main", "vcs_stage").is_err());
        host.set_project_trust(&root, true, false).await.unwrap();
        host.authorize_command("main", "vcs_stage").unwrap();
    }
    let project = host.open_project("main", &root).unwrap();
    assert!(!project.light);
    assert!(project.repos().primary().is_some());
    let doc = ops::doc::open(&host, "main", root.join("main.rs")).await.unwrap();
    assert!(doc.text.contains("fn main"));
    assert!(project.index.wait_idle(Duration::from_secs(1)));
    assert_eq!(project.index.status().files, 0);
    assert_eq!(project.index.status().symbols, 0);
    assert!(!project.index.status().indexing);
    assert!(project.lsp.servers().is_empty());
    #[cfg(not(feature = "ide-services"))]
    {
        let commands = ide_host::rpc::Dispatcher::standard().commands();
        assert!(commands.contains(&"doc_open"));
        assert!(commands.contains(&"term_spawn"));
        assert!(commands.contains(&"vcs_status"));
        for prefix in ["debug_", "notebook_", "run_", "coverage_", "analysis_", "deploy_", "tools_"] {
            assert!(!commands.iter().any(|command| command.starts_with(prefix)), "{prefix}");
        }
        assert!(commands.contains(&"build_model"), "read-only folder presentation remains available");
        for command in ["build_sync", "build_run", "maven_dependency_declaration", "maven_exclude_dependency"] {
            assert!(!commands.contains(&command), "{command}");
        }
    }
    assert!(!local.join("index").exists());
    let files = ops::nav::find_files(&host, "main", "main".into(), 20).unwrap();
    assert!(files.iter().any(|f| f.rel_path == "main.rs"));
    assert!(project.index.wait_idle(Duration::from_secs(1)));
    assert_eq!(project.index.status().files, 0, "file search does not populate a code index");
    host.close_project("main");
}

#[cfg(not(feature = "project-trust"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn git_operations_and_commit_hooks_work_without_project_trust() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    ide_vcs::init(&root).unwrap();
    for (key, value) in [("user.name", "OpenGit Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")]
    {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["config", key, value])
                .status()
                .unwrap()
                .success()
        );
    }
    let host = Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    // A Restricted Mode decision from a previous version must not block Git.
    host.trust.decide(&root, false, false).unwrap();
    assert!(!host.trust.trusted(&root).unwrap());
    let project = host.open_project("main", &root).unwrap();
    assert!(project.is_trusted());
    host.authorize_command("main", "vcs_stage").unwrap();
    std::fs::write(root.join("file.txt"), "content\n").unwrap();
    ops::vcs::vcs_stage(&host, "main", vec![root.join("file.txt")]).await.unwrap();
    let hook = root.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho 'OpenGit hook failure' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let options = ide_vcs::CommitOptions { run_hooks: true, ..Default::default() };
    let error = ops::vcs::vcs_commit(&host, "main", None, "blocked".into(), options).await.unwrap_err();
    assert!(error.to_string().contains("OpenGit hook failure"), "{error}");
    let options = ide_vcs::CommitOptions { run_hooks: false, ..Default::default() };
    ops::vcs::vcs_commit(&host, "main", None, "without commit hooks".into(), options).await.unwrap();
    host.set_project_trust(&root, false, false).await.unwrap();
    assert!(project.is_trusted(), "legacy trust changes cannot re-enable Restricted Mode");
    host.close_project("main");
    assert!(host.open_project("main", &root).unwrap().is_trusted());
    host.close_project("main");
}
