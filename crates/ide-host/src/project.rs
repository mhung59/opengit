//! One open project folder: documents, index, language servers, repositories,
//! watchers and the per-project services, opened by [`crate::Host::open_project`].

use crate::Host;
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, LanguageId, SharedSink};
use ide_index::ProjectIndex;
use ide_language::{FileTypes, LanguageRegistry, SyntaxCache};
use ide_lsp::LspManager;
use ide_syntax::StructureService;
use ide_text::ByteEdit;
use ide_vcs::{Repo, Repos};
use ide_vfs::Watcher;
use ide_workspace::documents::DocumentObserver;
use ide_workspace::{DocumentInfo, Documents, FileMoves, LocalHistory, ProjectRoots, SettingsStore, SourceFolder};
use parking_lot::{Mutex, RwLock};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Everything bound to one open project folder.
pub struct Project {
    pub(crate) trusted: Arc<AtomicBool>,
    pub root: PathBuf,
    /// Window-scoped event sink, for commands that emit project events.
    pub sink: SharedSink,
    /// The app's language definitions with this project's File Types applied.
    pub languages: Arc<LanguageRegistry>,
    pub settings: Arc<SettingsStore>,
    pub documents: Arc<Documents>,
    pub history: Arc<LocalHistory>,
    /// Undo stack of file move / rename refactorings.
    pub moves: FileMoves,
    pub index: Arc<ProjectIndex>,
    pub lsp: Arc<LspManager>,
    /// Git repositories: the one containing the project root and those nested below it.
    pub repos: Arc<RwLock<Repos>>,
    /// Incrementally maintained syntax trees of the open documents.
    pub syntax: Arc<SyntaxCache>,
    /// Tree-sitter structure queries (LSP fallback) over `syntax`.
    pub structure: Arc<StructureService>,
    /// Roots auto-detected from build files; see [`Project::roots`].
    pub detected_roots: Arc<RwLock<Vec<SourceFolder>>>,
    /// Per-project cache directory (build tool sync results…).
    pub cache_dir: PathBuf,
    /// Superseded launch snapshots retained until this project session ends.
    pub(crate) java_launch_snapshots: Mutex<crate::ops::java::cache::Session>,
    /// Native notebooks and owned kernels, scoped to this project incarnation.
    #[cfg(feature = "ide-services")]
    pub notebooks: Arc<crate::notebook::NotebookService>,
    pub(crate) watcher: Watcher,
    /// Watchers of the Project Structure content roots outside the project folder.
    pub(crate) content_watchers: Mutex<Vec<(PathBuf, Watcher)>>,
    pub(crate) _scratch_watcher: Option<Watcher>,
    /// A LightEdit window's loose files ([`Host::open_light`]): global settings only,
    /// nothing indexed, no language servers, repositories or project services.
    pub light: bool,
}

impl Host {
    /// Opens a repository workspace with the original editor and Git services.
    /// There is no project scan, language server, build discovery or code analysis.
    pub fn open_project(&self, window: &str, root: &Path) -> IdeResult<Arc<Project>> {
        let root = dunce::canonicalize(root)?;
        if let Ok(current) = self.project(window)
            && current.root == root
            && !current.light
        {
            return Ok(current);
        }
        self.close_project(window);
        let sink: SharedSink = (self.sink_for)(window);
        let trusted = Arc::new(AtomicBool::new(self.trust.execution_allowed(&root)?));
        let settings = Arc::new(SettingsStore::load(&self.config_dir, Some(&root)));
        let languages = Arc::new(self.languages.fork());
        languages.set_file_types(FileTypes::from_settings(&settings.effective().files, Some(&root)));
        let documents = documents(&sink, &languages, Some(&root));
        documents.set_file_defaults(ide_workspace::FileDefaults::from_settings(&settings.effective(), Some(&root)));
        let history = Arc::new(LocalHistory::open(&self.data_dir.join("history"), &root)?);
        let index = ProjectIndex::unindexed(&root, languages.clone(), self.syntax(), sink.clone())?;
        let lsp = LspManager::new(root.clone(), languages.clone(), sink.clone());
        lsp.set_execution_allowed(false);
        lsp.set_servers_hook(Box::new(|_, _| Vec::new()));
        let syntax = Arc::new(SyntaxCache::new(self.syntax()));
        documents.add_observer(Arc::new(SyntaxObserver(syntax.clone())));
        documents.add_observer(Arc::new(HistoryObserver(history.clone())));
        let repos = Arc::new(RwLock::new(Repos::enclosing(&root)?));
        for repo in repos.read().all() {
            repo.set_execution_allowed(trusted.load(Ordering::Acquire));
        }
        let excludes = exclude_globs(&root, &settings.effective(), &[]);
        let watcher = {
            let (root, sink, documents, history, repos, settings) =
                (root.clone(), sink.clone(), documents.clone(), history.clone(), repos.clone(), settings.clone());
            Watcher::start(
                &root.clone(),
                excludes,
                sink.clone(),
                Box::new(move |batch| {
                    let changed: Vec<PathBuf> = batch.created.iter().chain(&batch.modified).cloned().collect();
                    documents.on_disk_changed(&changed);
                    record_external_changes(&history, &changed, &batch.removed);
                    if batch.created.iter().chain(&batch.removed).chain(&batch.vcs).any(|p| p.ends_with(".git/HEAD")) {
                        scan_repositories(&root, &repos, &settings, &sink);
                    }
                    sink.emit(IdeEvent::VcsChanged { root: root.clone().into() });
                }),
            )?
        };
        let project_key = project_key(&root);
        #[cfg(feature = "ide-services")]
        let notebooks = crate::notebook::NotebookService::new(
            self.local_data_dir.join("notebook-runtime").join(uuid::Uuid::new_v4().to_string()),
            sink.clone(),
        );
        let project = Arc::new(Project {
            trusted,
            root: root.clone(),
            sink,
            languages,
            settings,
            documents,
            history,
            moves: FileMoves::new(),
            index,
            lsp,
            repos,
            structure: Arc::new(StructureService::new(syntax.clone())),
            syntax,
            detected_roots: Arc::default(),
            cache_dir: self.local_data_dir.join("cache").join(&project_key),
            java_launch_snapshots: Mutex::new(crate::ops::java::cache::Session::new(
                self.local_data_dir.join("cache").join(&project_key).join("build"),
            )),
            #[cfg(feature = "ide-services")]
            notebooks,
            watcher,
            content_watchers: Mutex::new(Vec::new()),
            _scratch_watcher: None,
            light: false,
        });
        apply_git_executable(&project.settings.effective());
        self.insert_project(window, project.clone());
        {
            let project = project.clone();
            std::thread::Builder::new().name("openidea-vcs-roots".into()).spawn(move || {
                scan_repositories(&project.root, &project.repos, &project.settings, &project.sink);
            })?;
        }
        Ok(project)
    }
}

impl Host {
    /// Opens `window` for editing loose files (LightEdit), `file` first: documents
    /// with syntax highlighting, saving and Local History over the global settings,
    /// without an index, language servers, repositories or project settings. A
    /// window already in LightEdit keeps its session; only its watchers grow.
    pub fn open_light(&self, window: &str, file: &Path) -> IdeResult<Arc<Project>> {
        let file = dunce::canonicalize(file)?;
        if file.is_dir() {
            return Err(IdeError::invalid(format!("{} is a folder", file.display())));
        }
        let dir = file.parent().map(Path::to_path_buf).ok_or_else(|| IdeError::invalid("no parent folder"))?;
        if let Ok(current) = self.project(window)
            && current.light
        {
            current.watch_light_dir(&dir);
            return Ok(current);
        }
        self.close_project(window);
        let sink: SharedSink = (self.sink_for)(window);
        let settings = Arc::new(SettingsStore::load(&self.config_dir, None));
        let effective = settings.effective();
        let languages = Arc::new(self.languages.fork());
        languages.set_file_types(FileTypes::from_settings(&effective.files, None));
        let documents = documents(&sink, &languages, None);
        documents.set_file_defaults(ide_workspace::FileDefaults::from_settings(&effective, None));
        let history = Arc::new(LocalHistory::open(&self.data_dir.join("history"), &dir)?);
        let index = ProjectIndex::unindexed(&dir, languages.clone(), self.syntax(), sink.clone())?;
        let lsp = LspManager::new(dir.clone(), languages.clone(), sink.clone());
        lsp.set_servers_hook(Box::new(|_, _| Vec::new()));
        let syntax = Arc::new(SyntaxCache::new(self.syntax()));
        documents.add_observer(Arc::new(SyntaxObserver(syntax.clone())));
        documents.add_observer(Arc::new(HistoryObserver(history.clone())));
        let watcher = light_watcher(&dir, &sink, &documents, &history)?;
        let project_key = project_key(&dir);
        #[cfg(feature = "ide-services")]
        let notebooks = crate::notebook::NotebookService::new(
            self.local_data_dir.join("notebook-runtime").join(uuid::Uuid::new_v4().to_string()),
            sink.clone(),
        );
        let project = Arc::new(Project {
            trusted: Arc::new(AtomicBool::new(false)),
            sink,
            languages,
            settings,
            documents,
            history,
            moves: FileMoves::new(),
            index,
            lsp,
            repos: Arc::default(),
            structure: Arc::new(StructureService::new(syntax.clone())),
            syntax,
            detected_roots: Arc::default(),
            cache_dir: self.local_data_dir.join("cache").join(&project_key),
            java_launch_snapshots: Mutex::new(crate::ops::java::cache::Session::new(
                self.local_data_dir.join("cache").join(&project_key).join("build"),
            )),
            #[cfg(feature = "ide-services")]
            notebooks,
            watcher,
            content_watchers: Mutex::new(Vec::new()),
            _scratch_watcher: None,
            light: true,
            root: dir,
        });
        tracing::info!("window {window} edits {} without a project", file.display());
        self.insert_project(window, project.clone());
        Ok(project)
    }
}

impl Project {
    pub fn is_trusted(&self) -> bool {
        self.trusted.load(Ordering::Acquire)
    }

    pub fn require_trust(&self) -> IdeResult<()> {
        if self.is_trusted() {
            Ok(())
        } else {
            Err(IdeError::unavailable("Project is in Restricted Mode. Trust the project to enable execution."))
        }
    }

    /// LightEdit: follow external changes to the files of `dir` (its own entries only).
    pub fn watch_light_dir(&self, dir: &Path) {
        if !self.light {
            return;
        }
        let dir = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let mut watchers = self.content_watchers.lock();
        if dir == self.root || watchers.iter().any(|(p, _)| *p == dir) {
            return;
        }
        match light_watcher(&dir, &self.sink, &self.documents, &self.history) {
            Ok(w) => watchers.push((dir, w)),
            Err(e) => tracing::warn!("watching {}: {e}", dir.display()),
        }
    }
}

/// The documents of a project whose languages and UI modes `languages` detects,
/// looking for frameworks' root markers up to `root` (anywhere for loose files).
fn documents(sink: &SharedSink, languages: &Arc<LanguageRegistry>, root: Option<&Path>) -> Arc<Documents> {
    let (detect, modes, root) = (languages.clone(), languages.clone(), root.map(Path::to_path_buf));
    Arc::new(
        Documents::new(sink.clone(), Box::new(move |p: &Path, first: Option<&str>| detect.detect(p, first)))
            .with_ui_mode_detection(Box::new(move |p: &Path, lang: &LanguageId| {
                modes.framework_ui_mode(lang, p, root.as_deref())
            })),
    )
}

fn light_watcher(
    dir: &Path,
    sink: &SharedSink,
    documents: &Arc<Documents>,
    history: &Arc<LocalHistory>,
) -> IdeResult<Watcher> {
    let (documents, history) = (documents.clone(), history.clone());
    Watcher::start_with(
        dir,
        Vec::new(),
        sink.clone(),
        Box::new(move |batch| {
            let changed: Vec<PathBuf> = batch.created.iter().chain(&batch.modified).cloned().collect();
            documents.on_disk_changed(&changed);
            record_external_changes(&history, &changed, &batch.removed);
        }),
        ide_vfs::WatchMode::Flat,
    )
}

/// Looks for repositories nested below the project (and the one containing it);
/// emits `VcsChanged` when the set of roots changed.
fn scan_repositories(root: &Path, repos: &RwLock<Repos>, settings: &SettingsStore, sink: &SharedSink) {
    let ignored = settings.effective().ignored_names();
    let skip = |p: &Path| p.file_name().is_some_and(|n| ignored.is_ignored_name(&n.to_string_lossy()));
    let mut roots = vec![root.to_path_buf()];
    roots.extend(content_roots(&settings.effective(), root));
    match Repos::discover_roots(&roots, &skip) {
        Ok(found) => {
            if found.roots() != repos.read().roots() {
                *repos.write() = found;
                sink.emit(IdeEvent::VcsChanged { root: root.to_path_buf().into() });
            }
        }
        Err(e) => tracing::warn!("looking for git repositories: {e}"),
    }
}

impl Project {
    pub fn refresh_repositories(&self) {
        scan_repositories(&self.root, &self.repos, &self.settings, &self.sink);
    }

    /// The project's git repositories.
    pub fn repos(&self) -> Repos {
        let repos = self.repos.read().clone();
        for repo in repos.all() {
            repo.set_execution_allowed(self.is_trusted());
        }
        repos
    }

    /// Runs `f` with the repository whose root is `at`, the project's primary repository
    /// when `None`; fails when there is none (a repository-scoped command never falls back
    /// to another repository).
    pub fn with_repo_at<T>(&self, at: Option<&Path>, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        let repos = self.repos();
        match at {
            Some(root) => match repos.at_root(root) {
                Some(repo) => self.run_in(repo, f),
                None => {
                    Err(IdeError::unavailable(format!("{} is not a git repository of the project", root.display())))
                }
            },
            None => match repos.primary() {
                Some(repo) => self.run_in(repo, f),
                None => Err(IdeError::unavailable("project is not a git repository")),
            },
        }
    }

    /// Runs `f` with the repository `path` (a file or folder) belongs to.
    pub fn with_repo_of<T>(&self, path: &Path, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        match self.repos().for_path(path) {
            Some(repo) => self.run_in(repo, f),
            None => Err(IdeError::unavailable(format!("{} is not in a git repository", path.display()))),
        }
    }

    fn run_in<T>(&self, repo: &Repo, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        let settings = self.settings.effective();
        if self.is_trusted() {
            apply_git_executable(&settings);
        }
        repo.set_ignored_names(settings.ignored_names());
        f(repo)
    }

    /// Runs `f` with the project's primary git repository, or fails when the project is not under git.
    pub fn with_repo<T>(&self, f: impl FnOnce(&Repo) -> IdeResult<T>) -> IdeResult<T> {
        self.with_repo_at(None, f)
    }

    /// Runs a VCS operation that rewrites the working tree (checkout, merge,
    /// rebase, pull, reset, stash, rollback): Local History gets a label and a
    /// snapshot of every locally changed file before, and a label after.
    /// `None` runs `f` like [`with_repo`](Self::with_repo) (operations that keep the working tree).
    pub fn with_repo_recorded<T>(
        &self,
        at: Option<&Path>,
        operation: Option<&str>,
        f: impl FnOnce(&Repo) -> IdeResult<T>,
    ) -> IdeResult<T> {
        let Some(name) = operation else { return self.with_repo_at(at, f) };
        self.history_label(&format!("Before {name}"));
        if let Ok(changed) = self.with_repo_at(at, |r| r.status()) {
            for file in changed.iter().take(HISTORY_BATCH_LIMIT) {
                if let Err(e) = self.history.record_file(&file.path, &format!("Before {name}"), false) {
                    tracing::debug!("local history: {e}");
                }
            }
        }
        let result = self.with_repo_at(at, f);
        self.history_label(&format!("After {name}"));
        result
    }

    fn history_label(&self, label: &str) {
        if let Err(e) = self.history.put_label(&self.root, label) {
            tracing::warn!("local history: {e}");
        }
    }

    /// Local History snapshots of `paths` before a refactoring changes them.
    pub fn record_before_refactoring(&self, paths: &[&Path], name: &str) {
        let label = format!("Before refactoring: {name}");
        for path in paths {
            let result = match self.documents.text_of(path) {
                Some(text) => self.history.record_event(path, &text, &label),
                None => self.history.record_file(path, &label, true).map(|_| ()),
            };
            if let Err(e) = result {
                tracing::debug!("local history: {e}");
            }
        }
    }

    /// Effective source / test / resource / excluded roots (detected + Project Structure marks).
    pub fn roots(&self) -> ProjectRoots {
        linked_roots(&self.root, &self.settings.effective(), &self.detected_roots.read())
    }

    /// Where the Maven / Gradle tool windows cache what the build tools reported.
    pub fn build_cache_dir(&self) -> PathBuf {
        self.cache_dir.join("build")
    }

    /// File masks (`ide_search::FileMask`) for Find in Files and inspections: the
    /// excluded roots, the ignored names and the "Exclude files" patterns (files,
    /// and everything under such folders).
    pub fn search_excludes(&self) -> Vec<String> {
        let mut out: Vec<String> =
            self.roots().excluded_globs().iter().map(|d| format!("{}/**", d.trim_start_matches('/'))).collect();
        let settings = self.settings.effective();
        let names =
            settings.files.ignored_names.iter().cloned().chain(settings.project_structure.exclude_file_patterns());
        for name in names {
            let name = name.trim();
            if !name.is_empty() && !name.contains(['/', ',']) {
                out.push(name.to_owned());
                out.push(format!("**/{name}/**"));
            }
        }
        out
    }

    /// Project files of `q.languages` under `q.root` containing `q.word` as a whole
    /// word (unsaved buffers included; excluded roots, ignored names and
    /// `.gitignore`d files skipped): the files a references search opens on its server.
    pub fn reference_candidates(
        &self,
        q: &ide_lsp::CandidateQuery,
        cancel: &CancellationToken,
    ) -> ide_lsp::CandidateFiles {
        let root = self
            .content_roots()
            .into_iter()
            .chain(std::iter::once(self.root.clone()))
            .filter(|root| q.root.starts_with(root))
            .max_by_key(|root| root.components().count());
        let Some(root) = root else {
            return ide_lsp::CandidateFiles::default();
        };
        let query = ide_search::WordQuery {
            word: q.word.clone(),
            dir: q.root.clone(),
            exclude: self.search_excludes(),
            limit: q.limit,
        };
        let filter = |rel: &str| q.languages.contains(&self.languages.detect(&root.join(rel), None));
        match ide_search::files_with_word(&root, &query, Some(&filter), &|p| self.documents.search_text_of(p), cancel) {
            Ok(found) => ide_lsp::CandidateFiles { files: found.files, limit_hit: found.limit_hit },
            Err(e) => {
                tracing::debug!("reference candidates: {}", e.message);
                ide_lsp::CandidateFiles::default()
            }
        }
    }

    /// `files.exclude`, the ignored names and the effective excluded roots (user-marked and detected).
    pub fn exclude_globs(&self) -> Vec<String> {
        exclude_globs(&self.root, &self.settings.effective(), &self.detected_roots.read())
    }

    /// Project Structure content roots besides the project folder (existing directories).
    pub fn content_roots(&self) -> Vec<PathBuf> {
        content_roots(&self.settings.effective(), &self.root)
    }

    /// Applies Settings › File Types; open documents whose language changed are
    /// re-detected (language servers and syntax trees follow) and the index
    /// re-parses the files whose language changed.
    pub fn apply_file_types(&self, settings: &ide_core::settings::Settings) {
        let before = Arc::new(self.languages.snapshot());
        if self.languages.set_file_types(FileTypes::from_settings(&settings.files, Some(&self.root))) {
            self.documents.redetect_languages();
            self.index.languages_changed(before);
        }
    }

    /// Applies changed content roots and exclude settings to the index (which
    /// rescans in the background) and the file watchers, without reopening the project.
    pub fn refresh_index_scope(&self) {
        if self.light {
            return;
        }
        let (roots, excludes) = (self.content_roots(), self.exclude_globs());
        self.lsp.set_content_roots(roots.clone());
        self.index.set_scope(index_roots(&self.root, roots.clone()), excludes.clone());
        self.watcher.set_excludes(&excludes);
        let mut watchers = self.content_watchers.lock();
        watchers.retain(|(p, _)| roots.contains(p));
        for (_, w) in watchers.iter() {
            w.set_excludes(&excludes);
        }
        for r in roots {
            if watchers.iter().any(|(p, _)| *p == r) {
                continue;
            }
            if let Some(w) =
                content_root_watcher(&r, &excludes, &self.sink, &self.index, &self.documents, &self.history)
            {
                watchers.push((r, w));
            }
        }
    }

    /// Use the open document's selected encoding, or the same detection/settings as opening it.
    pub fn vcs_encoding(&self, path: &Path, rev: Option<&str>) -> IdeResult<ide_vcs::TextEncoding> {
        let charset = self.file_encoding(path, rev)?;
        let encoding = ide_vcs::TextEncoding::from(charset);
        Ok(if self.documents.native_to_ascii_for(path) {
            encoding.with_ascii_conversion(ide_vfs::decode_properties_escapes, ide_vfs::encode_properties_ascii)
        } else {
            encoding
        })
    }

    fn file_encoding(&self, path: &Path, rev: Option<&str>) -> IdeResult<&'static encoding_rs::Encoding> {
        if let Some(id) = self.documents.by_path(path) {
            let info = self.documents.snapshot(id)?;
            return encoding_rs::Encoding::for_label(info.encoding.as_bytes())
                .ok_or_else(|| ide_core::IdeError::invalid("unknown document encoding"));
        }
        let defaults = self.documents.file_defaults();
        let fallback = defaults.fallback_for(path);
        if path.exists() {
            let loaded = ide_vfs::load_text_with_fallback(path, fallback)?;
            return encoding_rs::Encoding::for_label(loaded.encoding.as_bytes())
                .ok_or_else(|| ide_core::IdeError::invalid("unknown file encoding"));
        }
        let bytes = self.with_repo_of(path, |r| r.file_bytes_at(path, rev))?.unwrap_or_default();
        Ok(ide_vfs::detect_encoding(&bytes, fallback))
    }

    /// Current text of `path`: the open buffer when available, else the file on disk.
    pub fn text_of(&self, path: &Path) -> IdeResult<String> {
        match self.documents.text_of(path) {
            Some(text) => Ok(text),
            None => Ok(ide_text::normalize_line_endings(&self.documents.load_file(path)?.text).into_owned()),
        }
    }
}

/// Applies a multi-file edit through the document layer so open editors update live.
pub fn apply_workspace_edit(documents: &Documents, edit: &ide_core::WorkspaceEdit) -> IdeResult<()> {
    use ide_core::FileEdit;
    let mut edit = edit.clone();
    edit.deduplicate();
    for file in &edit.files {
        match file {
            FileEdit::Edit { path, edits } => {
                // Files not open in an editor are opened transiently and closed again.
                let (doc, transient) = match documents.by_path(path) {
                    Some(doc) => (doc, false),
                    None => (documents.open(path)?.id, true),
                };
                let result = documents.apply_edits(doc, edits).and_then(|_| documents.save(doc));
                if transient {
                    documents.close(doc);
                }
                result?;
            }
            FileEdit::Create { path, overwrite } => {
                if path.exists() {
                    if *overwrite {
                        ide_vfs::save_text(path, "", "utf-8", false)?;
                    }
                } else {
                    ide_vfs::create_file(path)?;
                }
            }
            FileEdit::Rename { from, to } => ide_vfs::rename(from, to)?,
            FileEdit::Delete { path, .. } => ide_vfs::delete(path)?,
        }
    }
    Ok(())
}

/// Files the watcher reports per batch that Local History snapshots.
const HISTORY_BATCH_LIMIT: usize = 500;

/// Local History for changes made outside the IDE (other tools, VCS, deletions).
/// Contents equal to the last snapshot (e.g. the IDE's own saves) are skipped.
fn record_external_changes(history: &LocalHistory, changed: &[PathBuf], removed: &[PathBuf]) {
    for path in changed.iter().take(HISTORY_BATCH_LIMIT) {
        if let Err(e) = history.record_file(path, "External change", false) {
            tracing::debug!("local history: {e}");
        }
    }
    if !removed.is_empty()
        && let Err(e) = history.note_removed(removed)
    {
        tracing::debug!("local history: {e}");
    }
}

pub fn history_retention(settings: &ide_core::settings::Settings) -> ide_workspace::Retention {
    ide_workspace::Retention {
        working_days: settings.files.local_history_days,
        max_bytes: u64::from(settings.files.local_history_max_mb.max(1)) * 1024 * 1024,
    }
}

/// A workspace uses its root only for state, never as indexed content.
fn index_roots(root: &Path, folders: Vec<PathBuf>) -> ide_index::IndexRoots {
    ide_index::IndexRoots { include_root: !root.join(ide_workspace::workspace::FILE).is_file(), folders }
}

/// Workspace members in manifest order, or extra Project Structure directories.
fn content_roots(settings: &ide_core::settings::Settings, root: &Path) -> Vec<PathBuf> {
    if let Ok(Some(workspace)) = ide_workspace::workspace::Workspace::load(root) {
        return workspace.projects;
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for r in &settings.project_structure.content_roots {
        let p = PathBuf::from(r.trim());
        if p.is_absolute() && p.is_dir() && !p.starts_with(root) && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Watches a content root outside the project: the index, open documents and
/// Local History follow its changes like the project folder's.
fn content_root_watcher(
    dir: &Path,
    excludes: &[String],
    sink: &SharedSink,
    index: &Arc<ProjectIndex>,
    documents: &Arc<Documents>,
    history: &Arc<LocalHistory>,
) -> Option<Watcher> {
    let (index, documents, history) = (index.clone(), documents.clone(), history.clone());
    Watcher::start(
        dir,
        excludes.to_vec(),
        sink.clone(),
        Box::new(move |batch| {
            let changed: Vec<PathBuf> = batch.created.iter().chain(&batch.modified).cloned().collect();
            index.update(&changed, &batch.removed);
            documents.on_disk_changed(&changed);
            record_external_changes(&history, &changed, &batch.removed);
        }),
    )
    .map_err(|e| tracing::warn!("content root watcher {}: {e}", dir.display()))
    .ok()
}

#[cfg(any(test, feature = "ide-services"))]
pub(crate) fn unlinked_maven_poms(root: &Path, settings: &ide_core::settings::Settings) -> Vec<PathBuf> {
    ide_build::maven::UnlinkedProjects::load(root, &settings.languages.java.maven).poms().map(PathBuf::from).collect()
}

fn linked_roots(root: &Path, settings: &ide_core::settings::Settings, detected: &[SourceFolder]) -> ProjectRoots {
    let unlinked = ide_build::maven::UnlinkedProjects::load(root, &settings.languages.java.maven);
    let detected = detected
        .iter()
        .filter(|folder| !folder.detected_from.as_ref().is_some_and(|pom| unlinked.contains(pom)))
        .cloned()
        .collect();
    ProjectRoots::compute(detected, &settings.project_structure)
}

fn exclude_globs(root: &Path, settings: &ide_core::settings::Settings, detected: &[SourceFolder]) -> Vec<String> {
    let mut globs = settings.file_excludes();
    globs.extend(linked_roots(root, settings, detected).excluded_globs());
    globs
}

pub(crate) fn project_key(root: &Path) -> String {
    // Stable FNV-1a directory name per project for caches.
    let s = root.to_string_lossy();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Feeds document edits into the per-project syntax tree cache.
struct SyntaxObserver(Arc<SyntaxCache>);

impl DocumentObserver for SyntaxObserver {
    fn opened(&self, info: &DocumentInfo) {
        if !info.large {
            self.0.open(info.id, &info.language, info.version);
        }
    }
    fn edited(&self, doc: ide_core::DocId, version: u32, edits: &[ByteEdit]) {
        self.0.edit(doc, version, edits);
    }
    fn closed(&self, doc: ide_core::DocId, _path: &Path) {
        self.0.close(doc);
    }
}

struct HistoryObserver(Arc<LocalHistory>);

impl DocumentObserver for HistoryObserver {
    fn saved(&self, _doc: ide_core::DocId, path: &Path, text: &str) {
        if let Err(e) = self.0.record(path, text, "Saved") {
            tracing::warn!("local history: {e}");
        }
    }
}

/// Settings › Version Control › Git › Path to Git executable (empty = auto-detect).
pub fn apply_git_executable(settings: &ide_core::settings::Settings) {
    let exe = settings.vcs.git.executable.trim();
    ide_vcs::set_git_executable((!exe.is_empty()).then(|| Path::new(exe)));
}

#[cfg(test)]
mod maven_linkage_tests {
    #[test]
    fn unlinked_roots_remain_plain_files() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["a", "b"] {
            std::fs::create_dir_all(tmp.path().join(name).join("src/main/java")).unwrap();
            std::fs::write(tmp.path().join(name).join("pom.xml"), "<project/>").unwrap();
        }
        std::fs::create_dir_all(tmp.path().join("a/child/src/main/java")).unwrap();
        std::fs::write(tmp.path().join("a/pom.xml"), "<project><modules><module>child</module></modules></project>")
            .unwrap();
        std::fs::write(tmp.path().join("a/child/pom.xml"), "<project/>").unwrap();
        let detected = ide_workspace::roots::detect(tmp.path());
        let mut settings = ide_core::settings::Settings::default();
        settings.languages.java.maven.unlinked_projects.push("a/pom.xml".into());
        let excluded_poms = super::unlinked_maven_poms(tmp.path(), &settings);
        assert_eq!(excluded_poms, vec![std::path::PathBuf::from("a/child/pom.xml"), "a/pom.xml".into()]);
        let configs = ide_run::detect_excluding(tmp.path(), &excluded_poms);
        assert!(configs.iter().any(|c| c.kind == "maven"));
        assert!(
            configs
                .iter()
                .filter(|c| c.kind == "maven")
                .all(|c| { c.cwd.as_ref().is_some_and(|dir| dir.as_ref() == std::path::Path::new("b")) })
        );
        let mut server = serde_json::from_value::<ide_language::LanguageServerConfig>(
            serde_json::json!({"name": "jdtls", "command": "jdtls"}),
        )
        .unwrap();
        ide_sdk::apply::configure_maven_import(&mut server, tmp.path(), &excluded_poms);
        let options = serde_json::to_value(server.initialization_options).unwrap();
        let exclusions = options.pointer("/settings/java/import/exclusions").unwrap().as_array().unwrap();
        assert!(exclusions.contains(&serde_json::json!(tmp.path().join("a").to_string_lossy().replace('\\', "/"))));
        assert!(
            exclusions.contains(&serde_json::json!(tmp.path().join("a/child").to_string_lossy().replace('\\', "/")))
        );
        let roots = super::linked_roots(tmp.path(), &settings, &detected);
        assert!(roots.roots.iter().any(|r| r.path == "b/src/main/java"));
        assert!(!roots.roots.iter().any(|r| r.path.starts_with("a/")));
        assert!(tmp.path().join("a/pom.xml").is_file());
        let model = crate::ops::build::load(tmp.path(), &tmp.path().join("cache"), &settings);
        assert_eq!(model.maven.unwrap().projects.len(), 1);
        settings.languages.java.maven.unlinked_projects.push("b/pom.xml".into());
        let model = crate::ops::build::load(tmp.path(), &tmp.path().join("cache"), &settings);
        assert!(model.maven.unwrap().projects.is_empty());
    }
}

#[cfg(test)]
fn vcs_path_changed(path: &Path) -> bool {
    !path.ends_with(".git/index") || !ide_vcs::is_own_index_write(path)
}

#[cfg(test)]
mod index_event_tests {
    use super::vcs_path_changed;

    #[test]
    fn status_write_is_suppressed_but_external_index_and_refs_refresh() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        };
        git(&["init", "-q"]);
        let file = dir.join("file.txt");
        std::fs::write(&file, "original\n").unwrap();
        git(&["add", "file.txt"]);
        // Same contents, different stat data: status must refresh the index.
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1))
            .unwrap();
        let index = dir.join(".git/index");
        let before = std::fs::read(&index).unwrap();
        let repo = ide_vcs::Repo::discover(dir).unwrap().unwrap();
        repo.status().unwrap();
        assert_ne!(before, std::fs::read(&index).unwrap(), "status must actually write the index");
        assert!(!vcs_path_changed(&index));
        assert!(!vcs_path_changed(&index), "duplicate notifications for the same identity");
        for path in [".git/HEAD", ".git/refs/heads/main", ".git/packed-refs"] {
            assert!(vcs_path_changed(&dir.join(path)));
        }
        std::fs::write(&file, "external staged change\n").unwrap();
        git(&["add", "file.txt"]);
        assert!(vcs_path_changed(&index));
        assert!(vcs_path_changed(&index));
        std::fs::remove_file(&index).unwrap();
        assert!(vcs_path_changed(&index));
    }
}

#[cfg(all(test, unix))]
mod workspace_edit_tests {
    use super::*;
    use ide_core::{FileEdit, LanguageId, Pos, Range, TextEdit, WorkspaceEdit};

    #[test]
    fn rename_via_symlink_updates_the_open_document_once() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("main.cpp");
        let alias = dir.path().join("alias.cpp");
        std::fs::write(&real, "add();\n").unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let documents = Documents::new(Arc::new(|_: IdeEvent| {}), Box::new(|_, _| LanguageId::new("cpp")));
        let doc = documents.open(&alias).unwrap();
        let changes = |path: PathBuf| FileEdit::Edit {
            path: path.into(),
            edits: vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "sum_values".into() }],
        };
        apply_workspace_edit(&documents, &WorkspaceEdit { files: vec![changes(real.clone()), changes(alias)] })
            .unwrap();
        assert_eq!(std::fs::read_to_string(real).unwrap(), "sum_values();\n");
        assert_eq!(documents.snapshot(doc.id).unwrap().text, "sum_values();\n");
    }
}
