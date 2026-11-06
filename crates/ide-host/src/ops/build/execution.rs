//! Build execution and Maven edits, available only to the standalone IDE host.
use super::{join_err, load};
use crate::ops::Channel;
use crate::rpc::Dispatcher;
use crate::{Host, Project, apply_workspace_edit};
use ide_build::compile::{self, BuildEvent, BuildKind, BuildResult};
use ide_build::pom_edit::{ArtifactKey, Exclusion};
use ide_build::{BuildModel, BuildTool, SyncOptions, SyncProgress};
use ide_core::{FileEdit, IdeError, IdeEvent, IdeResult, Location, Range, RequestId, WorkspaceEdit};

/// Runs Maven (`help:effective-pom dependency:tree`) or Gradle (`tasks --all`) in the
/// background, reporting progress on `on_progress`; cancellable with `cancel_request(request)`.
/// Returns the refreshed model; a failed build is reported in its `syncError`.
pub async fn build_sync(
    host: &Host,
    window: &str,
    tool: BuildTool,
    request: RequestId,
    offline: bool,
    profiles: Vec<String>,
    on_progress: Channel<SyncProgress>,
) -> IdeResult<BuildModel> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    let token = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        let current = load(&root, &cache, &settings);
        let env = match tool {
            BuildTool::Maven => current
                .maven
                .as_ref()
                .and_then(|m| m.projects.iter().find(|p| !p.env.is_empty()))
                .map(|p| p.env.clone())
                .unwrap_or_default(),
            BuildTool::Gradle => current.gradle.as_ref().map(|g| g.env.clone()).unwrap_or_default(),
        };
        let options = SyncOptions {
            offline,
            profiles,
            env,
            maven_command: ide_sdk::apply::maven_command(&root, &settings).map(|p| p.to_string_lossy().into_owned()),
            maven_options: ide_sdk::apply::maven_options(&root, &settings),
            maven_settings: settings.languages.java.maven.clone(),
            gradle_command: current.gradle.as_ref().map(|g| g.command.clone()),
        };
        let progress = |p: SyncProgress| {
            let _ = on_progress.send(p);
        };
        match tool {
            BuildTool::Maven => ide_build::sync_maven(&root, &cache, &options, &token, &progress)?,
            BuildTool::Gradle => ide_build::sync_gradle(&root, &cache, &options, &token, &progress)?,
        }
        Ok::<BuildModel, IdeError>(load(&root, &cache, &settings))
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    let model = result??;
    // jdtls re-imports on pom changes but misses artifacts added to ~/.m2
    // meanwhile ("missing artifact" stays until Invalidate Caches); asking it
    // to update the project configurations re-resolves them (#436). The same
    // holds for Gradle: it reuses its cached classpath on restart, so a
    // dependency added to `build.gradle` stays unresolved until told to sync.
    let build_files: Vec<String> = match tool {
        BuildTool::Maven => model.maven.iter().flat_map(|m| m.projects.iter().map(|p| p.pom.clone())).collect(),
        BuildTool::Gradle => {
            model.gradle.iter().flat_map(|g| g.projects.iter().filter_map(|p| p.build_file.clone())).collect()
        }
    };
    let lsp = project.lsp.clone();
    let uris = build_files.iter().map(|f| ide_lsp::path_to_uri_string(&project.root.join(f))).collect();
    tokio::spawn(async move {
        if let Err(e) = lsp.java_update_project_configs(&project.root, uris).await {
            tracing::debug!("java/projectConfigurationsUpdate: {e}");
        }
    });
    Ok(model)
}

/// The POM declaring `dependency` for the Maven module `pom` (project-relative): the
/// module's own, else its nearest parent in the project; its path, text and declaration.
fn declaring_pom(
    project: &Project,
    pom: &str,
    dependency: &ArtifactKey,
) -> IdeResult<(std::path::PathBuf, String, Range)> {
    let model = ide_build::maven::load(&project.root);
    for rel in ide_build::pom_edit::declaring_poms(&model, pom) {
        let path = project.root.join(&rel);
        let text = project.text_of(&path)?;
        if let Some(range) = ide_build::pom_edit::declaration(&text, dependency) {
            return Ok((path, text, range));
        }
    }
    Err(IdeError::not_found(format!(
        "{dependency} is not declared in a pom.xml of this project (it may come from an imported BOM or an external parent POM)"
    )))
}

/// Where the direct dependency `dependency` of the Maven module `pom` is declared.
pub async fn maven_dependency_declaration(
    host: &Host,
    window: &str,
    pom: String,
    dependency: ArtifactKey,
) -> IdeResult<Location> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let (path, _, range) = declaring_pom(&project, &pom, &dependency)?;
        Ok(Location::file(path, range))
    })
    .await
    .map_err(join_err)?
}

/// Adds an `<exclusion>` of `exclusion` to the declaration of the direct dependency
/// `dependency` of the Maven module `pom`, through the open document when there is one
/// (saved). Returns the declaration; nothing changes when it already excludes it.
pub async fn maven_exclude_dependency(
    host: &Host,
    window: &str,
    pom: String,
    dependency: ArtifactKey,
    exclusion: ArtifactKey,
) -> IdeResult<Location> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let (path, text, range) = declaring_pom(&project, &pom, &dependency)?;
        match ide_build::pom_edit::add_exclusion(&text, &dependency, &exclusion) {
            Some(Exclusion::Edit(edit)) => {
                let edit =
                    WorkspaceEdit { files: vec![FileEdit::Edit { path: path.clone().into(), edits: vec![edit] }] };
                apply_workspace_edit(&project.documents, &edit)?;
            }
            Some(Exclusion::Present) => {}
            None => return Err(IdeError::not_found(format!("{dependency} is not declared in {}", path.display()))),
        }
        Ok(Location::file(path, range))
    })
    .await
    .map_err(join_err)?
}

/// Build › Build Project / Rebuild Project / Build Module (`file`: a file or folder of the
/// module) / Build Artifacts, streaming the console and messages on `on_event`; cancellable
/// with `cancel_request(request)`. Diagnostics of `clear` (the files of the previous build)
/// are cleared first; the new messages are published as `build` diagnostics.
pub async fn build_run(
    host: &Host,
    window: &str,
    kind: BuildKind,
    file: Option<std::path::PathBuf>,
    request: RequestId,
    clear: Vec<std::path::PathBuf>,
    on_event: Channel<BuildEvent>,
) -> IdeResult<BuildResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, sink) = (project.root.clone(), project.build_cache_dir(), project.sink.clone());
    let settings = project.settings.effective();
    let config_dir = host.config_dir.clone();
    let token = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        for path in clear {
            sink.emit(IdeEvent::Diagnostics {
                path: path.into(),
                source: compile::DIAGNOSTICS_SOURCE.into(),
                items: Vec::new(),
            });
        }
        let plan = if let Some(workspace) = ide_workspace::workspace::Workspace::load(&root)? {
            let mut combined: Option<compile::BuildPlan> = None;
            for member in workspace.projects.iter().filter(|p| file.as_ref().is_none_or(|f| f.starts_with(p))) {
                let settings = ide_workspace::SettingsStore::load(&config_dir, Some(member)).effective();
                let member_cache = cache.join(crate::project::project_key(member));
                let plan = compile::plan(member, &load(member, &member_cache, &settings), kind, file.as_deref())?;
                match &mut combined {
                    Some(combined) => combined.steps.extend(plan.steps),
                    None => combined = Some(plan),
                }
            }
            let mut plan = combined.ok_or_else(|| IdeError::invalid("No workspace project to build"))?;
            plan.title = workspace.name;
            plan
        } else {
            compile::plan(&root, &load(&root, &cache, &settings), kind, file.as_deref())?
        };
        let result = compile::run(&root, &plan, &token, &|e| {
            let _ = on_event.send(e);
        })?;
        for (path, items) in compile::diagnostics(&result.messages) {
            sink.emit(IdeEvent::Diagnostics { path: path.into(), source: compile::DIAGNOSTICS_SOURCE.into(), items });
        }
        Ok(result)
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("build_sync", |c| async move {
        build_sync(
            &c.host,
            &c.window,
            c.arg("tool")?,
            c.arg("request")?,
            c.arg("offline")?,
            c.arg("profiles")?,
            c.sender("onProgress")?,
        )
        .await
    });
    d.add("maven_dependency_declaration", |c| async move {
        maven_dependency_declaration(&c.host, &c.window, c.arg("pom")?, c.arg("dependency")?).await
    });
    d.add("maven_exclude_dependency", |c| async move {
        maven_exclude_dependency(&c.host, &c.window, c.arg("pom")?, c.arg("dependency")?, c.arg("exclusion")?).await
    });
    d.add("build_run", |c| async move {
        build_run(
            &c.host,
            &c.window,
            c.arg("kind")?,
            c.arg("file")?,
            c.arg("request")?,
            c.arg("clear")?,
            c.sender("onEvent")?,
        )
        .await
    });
}
