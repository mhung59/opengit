import "./styles/global.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { activateFeatures, activateSettingsWindowFeatures, SettingsWindow, settingsWindowParent } from "./features";
import { isTauri } from "./platform/ipc";
import { installKeyboardDispatcher } from "./platform/keymap";
import { useProject } from "./platform/project";
import { hideSplash } from "./platform/splash";
import { prefetchLazyComponents } from "./ui";
import { Workbench } from "./workbench/Workbench";
import { activateSecondaryWindow, activateWorkbench } from "./workbench/activate";

if (import.meta.env.DEV && isTauri()) {
  // The Tauri MCP bridge returns eval results via `window.__TAURI__` on Windows/Linux
  // (macOS evaluates natively). Dev only, so release builds keep withGlobalTauri off.
  const [{ invoke }, { emit }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ ??= { core: { invoke }, event: { emit } };
}

// The native Settings window (`settings-<parent>`) loads this page too.
const settingsParent = settingsWindowParent();

if (settingsParent !== null) {
  activateSecondaryWindow();
  activateSettingsWindowFeatures(settingsParent);
} else {
  activateWorkbench();
  // `vite build --mode perf` is a production bundle for the performance harness (`perf/`).
  const perfBuild = import.meta.env.MODE === "perf";
  if ((import.meta.env.DEV || perfBuild) && !isTauri()) {
    const { registerDevSamples } = await import("./workbench/devSamples");
    registerDevSamples();
  }
  if (import.meta.env.DEV || perfBuild) {
    const { installPerfProbe } = await import("./workbench/perfProbe");
    installPerfProbe();
  }
  // Order matters: features (e.g. the terminal) install capture-phase key handlers
  // that must run before the global dispatcher.
  activateFeatures();
  installKeyboardDispatcher();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{settingsParent !== null ? <SettingsWindow /> : <Workbench />}</React.StrictMode>,
);
hideSplash();
// Warm frequent Git views only while a repository is open.
if (settingsParent === null) {
  let cancelPrefetch = () => {};
  const prefetch = () => {
    cancelPrefetch();
    if (useProject.getState().project) cancelPrefetch = prefetchLazyComponents();
  };
  prefetch();
  useProject.subscribe((state, previous) => {
    if (state.project !== previous.project) prefetch();
  });
}
