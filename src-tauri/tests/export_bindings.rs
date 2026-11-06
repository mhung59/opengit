//! `cargo test -p opengit --test export_bindings` regenerates `src/bindings.ts`
//! without launching the app (used by `pnpm gen:bindings` and CI drift checks).

#[test]
fn export_bindings() {
    opengit_lib::export_bindings(&opengit_lib::specta_builder());
    let bindings = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings.ts")).unwrap();
    for command in ["vcsStatus:", "vcsCommit:", "docOpen:", "termSpawn:", "sshAskpassAnswer:"] {
        assert!(bindings.contains(command), "missing Git client command: {command}");
    }
    for command in [
        "projectTrustStatus:",
        "projectTrustList:",
        "projectTrustSet:",
        "projectTrustRemoveLocation:",
        "buildSync:",
        "buildRun:",
        "mavenDependencyDeclaration:",
        "mavenExcludeDependency:",
        "toolsList:",
        "toolsInstall:",
        "toolsUninstall:",
        "sdkProjectLibraries:",
        "sdkLocateTools:",
        "deployUpload:",
        "deployDownload:",
        "deploySync:",
        "remoteList:",
        "remoteOpen:",
        "sshTerminalCommand:",
    ] {
        assert!(!bindings.contains(command), "retired IDE command is exposed: {command}");
    }
}
