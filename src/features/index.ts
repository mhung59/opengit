/**
 * Feature activation. Each feature exports `activate(): void | (() => void)`
 * that registers actions, tool windows, status items and services, returning
 * a disposer. The editor provides the editor service; app must install its launch
 * barrier before welcome can restore a remembered project.
 */
import { activate as editor } from "@/editor/core";
import { activate as welcome } from "./welcome";
import { activate as projectTree } from "./project-tree";
import { activate as search } from "./search";
import { activate as terminal } from "./terminal";
import { activate as vcs, activateSettingsPages as vcsPages } from "./vcs";
import { activate as settings, activateSettingsWindow } from "./settings";
import { activate as app, activateLocale as appLocale } from "./app";
import { activate as viewers } from "./viewers";
import { activate as vim, activateSettingsPages as vimPages } from "./vim";
import { activate as ssh } from "./ssh";

type Activate = () => void | (() => void);

const features: Array<[string, Activate]> = [
  ["editor", editor],
  ["app", app],
  ["welcome", welcome],
  ["project-tree", projectTree],
  ["search", search],
  ["vcs", vcs],
  ["terminal", terminal],
  ["settings", settings],
  ["viewers", viewers],
  ["vim", vim],
  ["ssh", ssh],
];

export function activateFeatures(): () => void {
  const disposers: Array<() => void> = [];
  for (const [name, activate] of features) {
    try {
      const d = activate();
      if (d) disposers.push(d);
    } catch (e) {
      console.error(`feature ${name} failed to activate`, e);
    }
  }
  return () => disposers.reverse().forEach((d) => d());
}

export { SettingsWindow, settingsWindowParent } from "./settings";

/**
 * The native Settings window of project window `parent`: only the settings
 * pages (no workbench, project, editors or background services).
 */
export function activateSettingsWindowFeatures(parent: string): () => void {
  const pages: Array<[string, Activate]> = [
    ["locale", appLocale],
    ["settings", () => activateSettingsWindow(parent)],
    ["vim", vimPages],
    ["vcs", vcsPages],
  ];
  const disposers: Array<() => void> = [];
  for (const [name, activate] of pages) {
    try {
      const d = activate();
      if (d) disposers.push(d);
    } catch (e) {
      console.error(`settings pages of ${name} failed to activate`, e);
    }
  }
  return () => disposers.reverse().forEach((d) => d());
}
