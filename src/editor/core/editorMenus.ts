/** Open In, Local History and Git menu entries for text editors. */
import { usePlatform } from "@/platform/platformInfo";
import { type MenuItem } from "@/ui";
import { menuGroupItems } from "@/workbench/contributions";

/** Open In › for a file: Project View, Finder / Explorer / Files, Terminal. */
export function openInMenu(path: string): MenuItem {
  return {
    label: "Open In",
    submenu: [
      { kind: "action", action: "navigate.selectIn", arg: { path }, label: "Project View" },
      { kind: "action", action: "project.revealInFinder", arg: path, label: revealLabel() },
      { kind: "action", action: "project.openInTerminal", arg: path, label: "Terminal" },
      { kind: "separator" },
      ...menuGroupItems("openIn", { paths: [path] }),
    ],
  };
}

export function localHistoryMenu(path: string): MenuItem {
  return {
    label: "Local History",
    submenu: [
      { kind: "action", action: "vcs.localHistory", arg: { path }, label: "Show History" },
      { kind: "action", action: "localHistory.putLabel", label: "Put Label…" },
    ],
  };
}

/** Git › for one file (editor and editor tab menus). */
export function gitMenu(path: string): MenuItem {
  return {
    label: "Git",
    submenu: [
      { kind: "action", action: "vcs.commit", label: "Commit File…" },
      { kind: "action", action: "vcs.addToVcs", arg: [path], label: "Add" },
      { kind: "separator" },
      { kind: "action", action: "vcs.annotate", arg: path, label: "Annotate with Git Blame" },
      { kind: "action", action: "vcs.showDiff", arg: [path], label: "Show Diff" },
      { kind: "action", action: "vcs.compareWithBranch", arg: { path }, label: "Compare with Branch…" },
      { kind: "action", action: "vcs.showHistory", arg: [path], label: "Show History" },
      { kind: "action", action: "vcs.rollback", arg: [path], label: "Rollback…" },
      { kind: "separator" },
      { kind: "action", action: "vcs.push", label: "Push…" },
      { kind: "action", action: "vcs.update", label: "Pull…" },
      { kind: "action", action: "vcs.fetch", label: "Fetch" },
      { kind: "separator" },
      { kind: "action", action: "vcs.branches", label: "Branches…" },
    ],
  };
}

/** "Finder" / "Explorer" / "Files", like IDEA's Open In submenu. */
function revealLabel(): string {
  const os = usePlatform.getState().os;
  return os === "macos" ? "Finder" : os === "windows" ? "Explorer" : "Files";
}
