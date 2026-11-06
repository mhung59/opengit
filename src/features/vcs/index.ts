/**
 * Version control (Git) feature: status decorations, title bar branch widget,
 * editor change markers / annotations, Commit and Git tool windows, diff,
 * merge and Local History editors, remote operations.
 */
import { editorsFor, registerEditorContribution } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { lazyComponent } from "@/ui";
import {
  notifications,
  registerEditorKind,
  registerMenuGroup,
  registerOverlay,
  registerSettingsPage,
  registerTitleItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { registerVcsActions } from "./actions";
import { annotationsShown, blameSlot } from "./blame";
import { BranchWidget, useBranchesPopup } from "./BranchWidget";
import { installChangelists } from "./changelists";
import { installPreparedMessage, useCommit } from "./commitStore";
import { registerCompareActions } from "./compare";
import { installFileConfirmations } from "./confirmations";
import { showConflictsDialog } from "./conflictsUi";
import { VcsDialogHost } from "./dialogs";
import { DIFF_KIND, diffTitle, type DiffData } from "./diffInput";
import { changeMarkers } from "./gutter";
import { registerHistoryActions, trackOperationContext } from "./historyActions";
import { installHunkPopup } from "./HunkPopup";
import { installIncomingCheck } from "./incoming";
import { inlineBlame } from "./inlineBlame";
import { registerLocalHistoryActions } from "./localHistoryActions";
import { LOCAL_HISTORY_KIND } from "./localHistoryKind";
import { registerLogPaneActions } from "./logPaneActions";
import { installGitLog, selectGitTab, useGitLog } from "./logStore";
import { MERGE_KIND, type MergeData } from "./mergeKind";
import { baseName } from "./model";
import { controlLabel, controlOperation, inProgress } from "./operations";
import { installVcsStore, onConflictsAppeared, onConflictsCleared, useVcs } from "./store";

function trackTitleItem(): () => void {
  let dispose: (() => void) | null = null;
  const sync = (available: boolean) => {
    if (available && !dispose) {
      dispose = registerTitleItem({
        id: "vcs.branch",
        title: "VCS Widget",
        align: "left",
        priority: 10,
        component: BranchWidget,
      });
    } else if (!available && dispose) {
      dispose();
      dispose = null;
      useBranchesPopup.setState({ open: false });
    }
  };
  sync(useVcs.getState().available);
  const unsub = useVcs.subscribe((s, p) => {
    if (s.available !== p.available) sync(s.available);
  });
  return () => {
    unsub();
    dispose?.();
  };
}

/**
 * The Commit tool window exists with the non-modal commit interface only; with the
 * modal one its tabs move to the Git tool window (and Commit… opens a dialog).
 */
function trackCommitWindow(): () => void {
  let dispose: (() => void) | null = null;
  const sync = (nonModal: boolean) => {
    if (nonModal && !dispose) {
      dispose = registerToolWindow({
        id: "commit",
        title: "Commit",
        icon: "toolwindow-commit",
        anchor: "left",
        order: 1,
        component: lazyComponent(() => import("./CommitView").then((m) => m.CommitToolWindow), { preload: true }),
        headerContent: lazyComponent(() => import("./CommitView").then((m) => m.CommitTabs)),
        tabsReplaceTitle: true,
        useBadge: () => {
          const n = useVcs((s) => s.status.length);
          return n || null;
        },
      });
      // The Git window's Local Changes / Shelf / Stash tabs are gone: back to its Log.
      if (["changes", "shelf", "stashes"].includes(useGitLog.getState().tab)) selectGitTab("log");
    } else if (!nonModal && dispose) {
      dispose();
      dispose = null;
    }
  };
  sync(workflowSettings().vcs.commit.nonModal);
  const unsub = onWorkflowSettingsChange((w) => w.vcs.commit.nonModal, sync);
  return () => {
    unsub();
    dispose?.();
  };
}

function conflictsBody(names: string[]): string {
  const list = names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
  return names.length === 1
    ? tx`${names.length} file has conflicts: ${list}`
    : tx`${names.length} files have conflicts: ${list}`;
}

/** Settings › Version Control › Log (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: "vcs.log",
    title: "Log",
    order: 6,
    keywords: ["git log", "references", "tags", "columns", "commit time"],
    component: lazyComponent(() => import("./LogSettingsPage").then((m) => m.LogSettingsPage)),
  });
}

export function activate(): () => void {
  onConflictsAppeared((files) =>
    notifications().notify({
      group: "vcs",
      level: "warning",
      key: "vcs.conflicts",
      title: "Merge conflicts",
      body: conflictsBody(files.map((f) => baseName(f.path))),
      sticky: true,
      actions: [{ label: "Resolve…", run: showConflictsDialog }],
    }),
  );

  onConflictsCleared(() => {
    notifications().expire?.("vcs.conflicts");
    // As IDEA does once the last conflict is resolved: offer to continue the stopped operation.
    const op = inProgress();
    if (op)
      notifications().notify({
        group: "vcs",
        level: "info",
        key: "vcs.conflicts",
        title: "All conflicts resolved",
        sticky: true,
        actions: [
          op === "merge"
            ? { label: "Commit…", run: () => void executeAction("vcs.commit") }
            : { label: controlLabel(op, "continue"), run: () => void controlOperation("continue", op) },
          { label: controlLabel(op, "abort"), run: () => void controlOperation("abort", op) },
        ],
      });
  });

  useCommit.setState({ signOff: workflowSettings().vcs.git.signOff });
  const disposers = [
    installVcsStore(),
    installGitLog(),
    installPreparedMessage(),
    installIncomingCheck(),
    installFileConfirmations(),
    // Settings › Git › Sign-off commit: the default of Commit Options › Sign-off Commit.
    onWorkflowSettingsChange(
      (w) => w.vcs.git.signOff,
      (signOff) => useCommit.setState({ signOff }),
    ),
    registerVcsActions(),
    registerHistoryActions(),
    registerLogPaneActions(),
    activateSettingsPages(),
    registerLocalHistoryActions(),
    installChangelists(),
    trackOperationContext(),
    registerCompareActions(),
    trackTitleItem(),
    installHunkPopup(),
    registerOverlay({ id: "vcs.dialogs", component: VcsDialogHost }),
    trackCommitWindow(),
    registerToolWindow({
      id: "git",
      title: "Git",
      icon: "toolwindow-git",
      anchor: "bottom",
      order: 5,
      component: lazyComponent(() => import("./GitLog").then((m) => m.GitToolWindow), { preload: true }),
      headerContent: lazyComponent(() => import("./GitLog").then((m) => m.GitTabs)),
    }),
    registerEditorKind({
      kind: DIFF_KIND,
      component: lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor), { preload: true }),
      title: (input) => diffTitle(input.data as DiffData),
      icon: () => "diff",
    }),
    registerEditorKind({
      kind: MERGE_KIND,
      component: lazyComponent(() => import("./MergeEditor").then((m) => m.MergeEditor)),
      title: (input) => `Merge: ${baseName((input.data as MergeData).path)}`,
      icon: () => "branch",
    }),
    registerEditorKind({
      kind: LOCAL_HISTORY_KIND,
      component: lazyComponent(() => import("./LocalHistory").then((m) => m.LocalHistoryEditor)),
      title: (input) => `Local History: ${baseName((input.data as { path: string }).path)}`,
      icon: () => "clock",
    }),
    registerEditorContribution({
      id: "vcs.changeMarkers",
      order: 60,
      extensions: (ctx) => [changeMarkers(ctx), blameSlot(), inlineBlame(ctx)],
    }),
    registerMenuGroup({
      id: "vcs.gutter",
      menus: ["editorGutter"],
      order: 10,
      items: (_menu, { paths: [path] }) => {
        if (!path || !getContext().vcsAvailable) return [];
        const shown = editorsFor(path).some((h) => annotationsShown(h.view));
        return [
          {
            label: shown ? "Close Annotations" : "Annotate with Git Blame",
            run: () => void executeAction("vcs.annotate", path),
          },
        ];
      },
    }),
  ];
  return () => {
    onConflictsAppeared(() => undefined);
    disposers.reverse().forEach((d) => d());
  };
}
