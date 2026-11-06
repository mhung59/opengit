import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { BranchesPanel } from "./LogBranches";
import { CommitList } from "./LogCommits";
import { CommitDetails } from "./LogDetails";
import { FilterBar } from "./LogFilters";
import { branchesByRepo } from "./multiRoot";
export { BranchesPanel } from "./LogBranches";
export { commitMenu, GraphCell, RefLabels } from "./LogCommits";
export { changesMenu, CommitDetails } from "./LogDetails";
export { graphOptionsMenu, viewOptionsMenu } from "./LogFilters";
/** Git tool window: Log (graph, filters, commit details) and Console tabs. */
import { tx } from "@/platform/i18n";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { EmptyState, IconButton, SplitGroup, SplitHandle, SplitPanel, T, Tabs } from "@/ui";
import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef } from "react";
import { ChangesTree, StashContent, tabItems, useStashTabCounts } from "./CommitView";
import styles from "./GitLog.module.css";
import { WorktreesPanel } from "./gitMenuDialogs";
import { gitTabs, shownTab } from "./gitTabs";
import { useLogOptions } from "./logOptions";
import { closeLogTab, initLogBranchFilter, refsSignature, reloadLog, selectGitTab, useGitLog } from "./logStore";
import { clearConsole, useVcsConsole } from "./ops";
import { loadBranches, useVcs } from "./store";

/** The Git window's tabs (they depend on the commit interface) and the one shown. */
function useGitTabs() {
  const available = useVcs((s) => s.available);
  const modal = useWorkflowSettings((s) => !s.vcs.commit.nonModal);
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const tab = useGitLog((s) => s.tab);
  const logTabs = useGitLog((s) => s.logTabs);
  const counts = useStashTabCounts(available && modal);
  const tabs = gitTabs({ modal, combine, tab, logTabs, ...counts });
  return { tabs, shown: shownTab(tab, tabs, combine) };
}

/** Tool window header: [Local Changes / Stash…] Log, log tabs, Console and Worktrees content tabs. */
export function GitTabs() {
  const available = useVcs((s) => s.available);
  const { tabs, shown } = useGitTabs();
  if (!available) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.headerTabs}
      activeId={shown}
      onSelect={selectGitTab}
      onClose={closeLogTab}
      aria-label="Git"
      panelIdPrefix="openidea-git"
      items={tabItems(tabs)}
    />
  );
}

export function GitToolWindow() {
  const { shown } = useGitTabs();
  const shownLog = useGitLog((s) => s.shownLog);
  const available = useVcs((s) => s.available);
  if (!available)
    return (
      <EmptyState title="Version control is not configured">
        <T>The project is not a Git repository.</T>
      </EmptyState>
    );
  return (
    <div
      className={styles.root}
      role="tabpanel"
      id={`openidea-git-panel-${shown}`}
      aria-labelledby={`openidea-git-tab-${shown}`}
    >
      {shown === "changes" ? (
        <ChangesTree mode="local" />
      ) : shown === "shelf" || shown === "stashes" ? (
        <StashContent tab={shown} />
      ) : shown === "console" ? (
        <ConsoleView />
      ) : shown === "worktrees" ? (
        <WorktreesPanel className={styles.worktrees} listClassName={styles.worktreeList} />
      ) : (
        // Each log tab has its own view (its filters and commits are swapped into the store).
        <LogView key={shownLog} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log

function LogView() {
  const version = useVcs((s) => s.version);
  const commits = useGitLog((s) => s.commits);
  const selection = useGitLog((s) => s.selection);
  const root = useVcs((s) => s.root);
  const repo = useVcs((s) => s.roots);
  const showBranches = useLogOptions((s) => s.showBranches);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const lastRefs = useRef<string | null>(null);
  const allRefs = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    void branchesByRepo(repo)
      .then((all) => {
        if (!live) return;
        const signature = JSON.stringify(all);
        if (allRefs.current !== null && allRefs.current !== signature) void reloadLog({ preserve: true });
        allRefs.current = signature;
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo, version]);

  // On mount, when the window switches to another project and when another of its
  // repositories is selected (its branches are needed to notice its refs moving).
  useEffect(() => {
    lastRefs.current = null;
    allRefs.current = null;
    if (!useGitLog.getState().commits.length) void reloadLog();
    void loadBranches().catch(() => undefined);
  }, [root, repo]);

  // Once the repository's branches are known, settle the branch filter (the
  // remembered refs, else the current branch) and load the log with it.
  useEffect(() => {
    if (!branchesLoaded) return;
    // The refs the log is loaded with, so the first checkout or commit after this reloads it.
    const { branch, branches } = useVcs.getState();
    lastRefs.current = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const settled = initLogBranchFilter();
    const { commits, loading } = useGitLog.getState();
    if (settled || (!commits.length && !loading)) void reloadLog();
  }, [root, repo, branchesLoaded]);

  // HEAD or a branch tip moved (commit, undo, reset, rebase, fetch…): reload (keeps the selection).
  useEffect(() => {
    const { branch, branches, branchesLoaded } = useVcs.getState();
    if (!branchesLoaded) return;
    const refs = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const previous = lastRefs.current;
    lastRefs.current = refs;
    if (previous !== null && previous !== refs && useGitLog.getState().commits.length)
      void reloadLog({ preserve: true });
  }, [version]);

  return (
    // Its own layout without the Branches pane, so each keeps its sizes.
    <SplitGroup
      key={showBranches ? "branches" : "no-branches"}
      orientation="horizontal"
      id={showBranches ? "git-log" : "git-log-no-branches"}
      className={styles.split}
    >
      {showBranches && (
        <>
          <SplitPanel id="branches" defaultSize="18%" minSize="120px">
            <BranchesPanel />
          </SplitPanel>
          <SplitHandle />
        </>
      )}
      <SplitPanel id="commits" defaultSize="54%" minSize="25%">
        <div className={styles.log}>
          <FilterBar />
          <CommitList />
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="details" defaultSize="28%" minSize="15%">
        <CommitDetails key={selection.join(" ") || "none"} commits={commits} />
      </SplitPanel>
    </SplitGroup>
  );
}

// ---------------------------------------------------------------------------
// Console

function ConsoleView() {
  const lines = useVcsConsole((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className={styles.consoleWrap}>
      <div className={styles.consoleBar}>
        <IconButton icon="trash" title="Clear All" size="small" onClick={clearConsole} />
      </div>
      <div
        ref={ref}
        className={styles.console}
        tabIndex={0}
        role="log"
        onKeyDown={copySelectionOnKeyDown}
        aria-label={tx("Git console")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
      >
        {!lines.length && (
          <div className={styles.muted}>
            <T>Git commands run by the IDE appear here.</T>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className={clsx(styles.line, styles[`line-${l.kind}`])}>
            {l.kind === "cmd" && (
              <span className={styles.time}>{new Date(l.time).toLocaleTimeString(undefined, { hour12: false })} </span>
            )}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
