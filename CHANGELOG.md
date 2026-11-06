# Changelog

## 0.1.1

- Open repositories directly without the IDE Project Trust prompt, Restricted Mode banner or trust settings. Existing restricted decisions no longer block Git operations in OpenGit.
- Add the new OG logo across the welcome screen, About dialog, splash, favicon and desktop application icons.
- Remove unused desktop IPC adapters and dependencies; keep IDE-only backend services behind feature flags for the standalone host.
- Split Git Log, editor tab/menu state and workbench registries into smaller modules.
- Load secondary views on demand and prefetch frequent Git views only after opening a repository.
- Preserve Git hooks, commit author/sign-off, terminal, diff/merge and Local History workflows.
- Update regression tests and CI, including full Knip checks for unused files, dependencies, exports and types.

Windows x64 installer and SHA-256 checksums are provided with the GitHub release.
