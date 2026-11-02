# OpenIDEA — Git edition

[OpenGit](https://github.com/mhung59/opengit) keeps OpenIDEA's original desktop interface and concentrates it on Git management. It retains the welcome screen, project tree, editor tabs and splits, themes, keyboard shortcuts, Commit/Shelf/Stash panel, Git Log/Console/Worktrees, branch menus, diff viewer, merge editor and Local History.

AI agents, database clients and the installable plugin system have been removed. Build/run/debug, coverage/profiling, HTTP clients, deployment and remote development are not activated or exposed. The integrated Terminal (tabs, splits, shortcuts and Settings) remains available alongside Git Console. Bookmarks and the Notifications tool window, bell and menu entries are removed. Operation error messages remain visible. The editor still opens and saves files and provides syntax highlighting, folding, file search and text search; no project code scan or language server starts when a repository opens. Commit options retain Git hooks, author and sign-off, and omit code formatting, code analysis and TODO checks.

The original workbench and VCS components are used directly. There is no replacement interface. Shared backend libraries needed by these components are retained; removing a feature does not mean deleting every library that also supports the editor.

## Run

Requires Node.js, pnpm, Rust 1.96+, Git and the Tauri 2 native build prerequisites. On Windows install MSVC Build Tools and WebView2.

```sh
pnpm install
pnpm dev:app
```

If pnpm is not installed globally, use `npx pnpm install` and `npx pnpm dev:app`.

`pnpm dev` previews the original workbench with sample data in a browser. Real repositories and Git operations use the desktop app.

## Validation

```sh
pnpm build
pnpm exec vitest run src/features/vcs src/platform/product.test.ts
pnpm exec playwright test e2e/gitEdition.spec.ts e2e/diff.spec.ts
cargo check -p opengit --locked
cargo test -p ide-host --test git_edition --test vcs_roots --test vcs_encoding
```

Set `OPENIDEA_E2E_CHANNEL=msedge` to use installed Edge for browser tests; otherwise install Playwright Chromium.

## Upstream and license

Derived from [l0ng-ai/openidea](https://github.com/l0ng-ai/openidea). Apache-2.0; attribution is retained in LICENSE, NOTICE and THIRD_PARTY_LICENSES.md. Not affiliated with JetBrains. IntelliJ IDEA is a JetBrains trademark.

## Windows installer

```sh
pnpm build:windows
```

The production NSIS installer is generated under `target/release/bundle/nsis/`. The app uses the `io.github.mhung59.opengit` identifier and installs for the current Windows user, separately from upstream OpenIDEA. Git must be installed and available on PATH.
