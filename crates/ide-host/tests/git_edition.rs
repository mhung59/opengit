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
    host.trust.decide(&root, true, false).unwrap();
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
    assert!(!local.join("index").exists());
    let files = ops::nav::find_files(&host, "main", "main".into(), 20).unwrap();
    assert!(files.iter().any(|f| f.rel_path == "main.rs"));
    assert!(project.index.wait_idle(Duration::from_secs(1)));
    assert_eq!(project.index.status().files, 0, "file search does not populate a code index");
    host.close_project("main");
}
