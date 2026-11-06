//! Read-only Maven / Gradle presentation. Build execution is an optional IDE service.
use crate::Host;
use crate::rpc::Dispatcher;
use ide_build::BuildModel;
use ide_core::settings::Settings;
use ide_core::{IdeError, IdeResult};
use std::collections::BTreeMap;
use std::path::Path;

#[cfg(feature = "ide-services")]
mod execution;
#[cfg(feature = "ide-services")]
pub use execution::{build_run, build_sync, maven_dependency_declaration, maven_exclude_dependency};

fn join_err(e: tokio::task::JoinError) -> IdeError {
    IdeError::internal(e.to_string())
}

/// `JAVA_HOME`: the project JDK, else the installed JDK matching `release` (none
/// when the project names no version).
fn java_env(project_jdk: Option<&ide_sdk::java::Jdk>, release: Option<u32>) -> BTreeMap<String, String> {
    let jdks = ide_sdk::java::installed_jdks();
    let jdk = project_jdk.or_else(|| release.and_then(|r| ide_sdk::java::pick_jdk(&jdks, Some(r))));
    jdk.map(|j| BTreeMap::from([("JAVA_HOME".to_owned(), j.home.to_string_lossy().into_owned())])).unwrap_or_default()
}

/// The build model with the launch settings applied: the JDK (`JAVA_HOME`), and
/// the Maven home and options from Settings › Maven.
pub fn load(root: &Path, cache: &Path, settings: &Settings) -> BuildModel {
    let mut model = ide_build::load_linked(
        root,
        cache,
        ide_sdk::apply::maven_local_repository(root, settings),
        &settings.languages.java.maven,
    );
    let jdk = ide_sdk::apply::project_jdk(root, settings);
    if let Some(m) = &mut model.maven {
        let mvn = ide_sdk::apply::maven_command(root, settings);
        let options = ide_sdk::apply::maven_options(root, settings);
        for p in &mut m.projects {
            p.env = java_env(jdk.as_ref(), p.java_version);
            if let Some(mvn) = &mvn {
                p.command = mvn.to_string_lossy().into_owned();
            }
            p.options = options.clone();
        }
    }
    if let Some(g) = &mut model.gradle {
        g.env = ide_sdk::apply::gradle_env(root, settings, java_env(jdk.as_ref(), g.java_version));
        g.command = ide_sdk::apply::gradle_command(root, &root.join(&g.dir), settings).to_string_lossy().into_owned();
    }
    // A failed sync of a project no installed JDK can build says so first (with a Download JDK action).
    let missing = |release: Option<u32>| match jdk {
        Some(_) => None,
        None => ide_sdk::java::missing_jdk_message(&ide_sdk::java::installed_jdks(), release),
    };
    let explain = |error: &mut Option<String>, hint: Option<String>| {
        if let (Some(e), Some(hint)) = (error.as_mut(), hint) {
            *e = format!("{hint}\n{e}");
        }
    };
    if let Some(m) = &mut model.maven
        && m.sync_error.is_some()
    {
        let hint = m.projects.iter().find_map(|p| missing(p.java_version));
        explain(&mut m.sync_error, hint);
    }
    if let Some(g) = &mut model.gradle
        && g.sync_error.is_some()
    {
        let hint = if settings.languages.java.gradle.jvm.trim().is_empty() { missing(g.java_version) } else { None };
        explain(&mut g.sync_error, hint);
    }
    model
}

/// Maven and Gradle projects of the window's project, from the build files plus the last sync.
pub async fn build_model(host: &Host, window: &str) -> IdeResult<BuildModel> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    tokio::task::spawn_blocking(move || load(&root, &cache, &settings)).await.map_err(join_err)
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("build_model", |c| async move { build_model(&c.host, &c.window).await });
    #[cfg(feature = "ide-services")]
    execution::register(d);
}

#[cfg(test)]
mod gradle_settings_tests {
    use super::*;

    #[test]
    fn model_for_sync_tasks_and_compile_uses_gradle_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("build.gradle"), "plugins { id 'java' }").unwrap();
        let wrapper = root.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
        std::fs::write(&wrapper, "").unwrap();
        let mut settings = Settings::default();
        let default = load(root, &root.join("cache"), &settings).gradle.unwrap();
        assert_eq!(default.command, wrapper.to_string_lossy());
        settings.languages.java.gradle.jvm = "jdk21".into();
        settings.languages.java.gradle.user_home = "user-home".into();
        settings.languages.java.gradle.distribution = ide_core::settings::GradleDistribution::Local;
        settings.languages.java.gradle.home = "gradle-install".into();
        let model = load(root, &root.join("cache"), &settings).gradle.unwrap();
        assert_eq!(
            model.command,
            root.join("gradle-install")
                .join("bin")
                .join(if cfg!(windows) { "gradle.bat" } else { "gradle" })
                .to_string_lossy()
        );
        assert_eq!(model.env["JAVA_HOME"], root.join("jdk21").to_string_lossy());
        assert_eq!(model.env["GRADLE_USER_HOME"], root.join("user-home").to_string_lossy());
    }
}
