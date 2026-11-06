/** Virtualized commit list, graph lanes and reference labels. */
import type { Commit } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Spinner, T, showContextMenu, type MenuItem } from "@/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import styles from "./GitLog.module.css";
import { collapseLinear, computeGraph, hideLongEdges, laneColor, reachableFrom, type GraphRow } from "./graph";
import { refLabels, useLogOptions, type LogOptions } from "./logOptions";
import {
  extendCommitSelection,
  goToChild,
  goToParent,
  isMine,
  isPushed,
  loadMore,
  selectCommit,
  selectedCommits,
  toggleCommitSelection,
  useGitLog,
} from "./logStore";
import { formatTime } from "./model";
import { commitKey, commitRepo, graphCommit, type RepoCommit } from "./multiRoot";
import { repoName, useVcs } from "./store";

const ROW = 26;

const LANE = 14;

/** IDEA's Git Log commit context menu (Git.Log.ContextMenu); `selection` = all selected commits, newest first. */
export function commitMenu(c: Commit, selection: Commit[] = [c]): MenuItem[] {
  const many = selection.length > 1 && selection.some((x) => commitKey(x) === commitKey(c));
  const head = (commitRepo(c) ? useVcs.getState().heads[commitRepo(c)!]?.head : useVcs.getState().branch?.head) ?? null;
  const { outgoing } = useGitLog.getState();
  const pushed = (x: Commit) =>
    commitRepo(x) === undefined ? !!outgoing && !outgoing.has(x.id) : isPushed(commitKey(x));
  if (many) {
    const anyPushed = selection.some(pushed);
    return [
      { kind: "action", action: "vcs.log.copyRevision", arg: selection, label: "Copy Revision Numbers" },
      { kind: "action", action: "vcs.log.createPatch", arg: selection },
      { kind: "action", action: "vcs.log.cherryPick", arg: selection },
      ...(selection.length === 2
        ? [{ kind: "action", action: "vcs.log.compareVersions", arg: selection } satisfies MenuItem]
        : []),
      { kind: "separator" },
      { kind: "action", action: "vcs.log.revert", arg: selection, label: "Revert Commits" },
      { kind: "separator" },
      { kind: "action", action: "vcs.log.squashCommits", arg: selection, disabled: anyPushed },
      { kind: "action", action: "vcs.log.dropCommit", arg: selection, label: "Drop Commits", disabled: anyPushed },
    ];
  }
  const pushedCommit = pushed(c);
  // Without an upstream there is no outgoing set: allow pushing up to any commit of HEAD.
  const canPushHere =
    !!head &&
    ((commitRepo(c) === undefined ? !!outgoing : useGitLog.getState().tracked.has(commitRepo(c) ?? ""))
      ? !!outgoing?.has(commitKey(c))
      : true);
  return [
    { kind: "action", action: "vcs.log.copyRevision", arg: c },
    { label: "Copy Commit Message", run: () => void navigator.clipboard?.writeText(c.message) },
    { kind: "action", action: "vcs.log.createPatch", arg: c },
    { kind: "action", action: "vcs.log.cherryPick", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.checkoutRevision", arg: c },
    { kind: "action", action: "vcs.log.compareWithLocal", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.resetToHere", arg: c },
    { kind: "action", action: "vcs.log.revert", arg: c },
    { kind: "action", action: "vcs.log.undoCommit", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.editMessage", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.fixup", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.squashInto", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.dropCommit", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.interactiveRebase", arg: c, disabled: pushedCommit },
    { kind: "action", action: "vcs.log.pushUpToHere", arg: c, disabled: !canPushHere },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.rebaseOntoCommit",
      arg: c,
      label: tx`Rebase '${head ?? "HEAD"}' onto Selected Commit`,
      disabled: !head,
    },
    { kind: "action", action: "vcs.log.newBranch", arg: c },
    { kind: "action", action: "vcs.log.newTag", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.goToChild", arg: c },
    { kind: "action", action: "vcs.log.goToParent", arg: c, disabled: !c.parents.length },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.openInBrowser", arg: c },
  ];
}

export function CommitList() {
  const all = useGitLog((s) => s.commits);
  const allRows = useGitLog((s) => s.rows);
  const opts = useLogOptions();
  const user = useGitLog((s) => s.user);
  const headCommit = useVcs((s) => s.branch?.headCommit ?? null);
  const branches = useVcs((s) => s.branches);
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches]);
  // Date, No Merges and First Parent are applied by the backend with parent rewriting,
  // so the graph stays connected under them.
  const heads = useVcs((s) => s.heads);
  const headKeys = useMemo(
    () =>
      new Set(
        all.filter((c) => c.id === (commitRepo(c) ? heads[commitRepo(c)!]?.headCommit : headCommit)).map(commitKey),
      ),
    [all, heads, headCommit],
  );
  const collapsed = useMemo(
    () => (opts.collapseLinear ? collapseLinear(all.map(graphCommit), headKeys) : null),
    [all, opts.collapseLinear, headKeys],
  );
  const commits = useMemo(() => {
    if (!collapsed) return all;
    const byKey = new Map(all.map((c) => [commitKey(c), c]));
    return collapsed.commits.map((c) => byKey.get(c.id)!);
  }, [all, collapsed]);
  const rows = useMemo(() => {
    const laid = collapsed ? computeGraph(collapsed.graph).rows : allRows;
    return opts.longEdges ? laid : hideLongEdges(laid);
  }, [collapsed, allRows, opts.longEdges]);
  const filterBranches = useGitLog((s) => s.filters.branches);
  const currentBranch = useVcs((s) => s.branch?.head ?? null);
  // Nothing to tell apart when the log is filtered to the current branch.
  const onlyCurrent = filterBranches.length > 0 && filterBranches.every((b) => b === "HEAD" || b === currentBranch);
  const onBranch = useMemo(() => {
    if (!opts.highlightCurrentBranch || onlyCurrent) return null;
    const reach = new Set<string>();
    for (const head of headKeys) for (const id of reachableFrom(all.map(graphCommit), head)) reach.add(id);
    return reach;
  }, [all, headKeys, opts.highlightCurrentBranch, onlyCurrent]);
  const loading = useGitLog((s) => s.loading);
  const done = useGitLog((s) => s.done);
  const error = useGitLog((s) => s.error);
  const selected = useGitLog((s) => s.selected);
  const selection = useGitLog((s) => s.selection);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const revealTick = useGitLog((s) => s.revealTick);
  const scrollRef = useRef<HTMLDivElement>(null);
  const finished = done;
  const virtualizer = useVirtualizer({
    count: commits.length + (finished ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];

  useEffect(() => {
    if (!finished && !loading && last && last.index >= commits.length - 40) void loadMore();
  }, [last, commits.length, finished, loading]);

  const selectedIndex = selected ? commits.findIndex((c) => commitKey(c) === selected) : -1;
  useLayoutEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "center" });
    // Only on explicit reveal requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  const visible = useRef(commits);
  visible.current = commits;
  const pick = useCallback((id: string, e: ReactMouseEvent) => {
    if (e.button === 2) {
      if (!useGitLog.getState().selection.includes(id)) selectCommit(id);
    } else if (e.button !== 0) return;
    else if (e.shiftKey) extendCommitSelection(id, visible.current);
    else if (e.metaKey || e.ctrlKey) toggleCommitSelection(id);
    else selectCommit(id);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const lead = selectedIndex >= 0 ? commits[selectedIndex] : undefined;
    if (lead && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.key === "ArrowLeft") goToChild(lead);
      else void goToParent(lead);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(commits.length - 1, selectedIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = commits.length - 1;
    else if (e.key === "PageDown") next = Math.min(commits.length - 1, selectedIndex + 20);
    else if (e.key === "PageUp") next = Math.max(0, selectedIndex - 20);
    else return;
    e.preventDefault();
    const c = commits[next];
    if (c) {
      if (e.shiftKey) extendCommitSelection(commitKey(c), commits);
      else selectCommit(commitKey(c));
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  if (error && !commits.length) return <div className={styles.message}>{error}</div>;

  return (
    <div className={styles.listWrap}>
      {error && (
        <div role="alert" className={styles.message}>
          {error}
        </div>
      )}
      <div
        ref={scrollRef}
        className={styles.list}
        role="listbox"
        aria-label={tx("Commits")}
        aria-multiselectable
        aria-activedescendant={selectedIndex >= 0 ? `commit-${selectedIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {!commits.length && !loading && finished && (
          <div className={styles.message}>{headCommit ? tx("No commits match the filters") : tx("No commits yet")}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const c = commits[v.index];
            if (!c)
              return (
                <div key="loading" className={styles.row} style={{ top: v.start }}>
                  <Spinner size={12} />{" "}
                  <span className={styles.muted}>
                    <T>Loading…</T>
                  </span>
                </div>
              );
            return (
              <CommitRow
                key={commitKey(c)}
                id={`commit-${v.index}`}
                commit={c}
                graph={rows[v.index]}
                top={v.start}
                selected={selectedSet.has(commitKey(c))}
                head={headKeys.has(commitKey(c))}
                mine={opts.highlightMine && isMine(c, user)}
                onBranch={!!onBranch?.has(commitKey(c))}
                opts={opts}
                remoteNames={new Set((c as RepoCommit).remoteNames ?? remoteNames)}
                onPick={pick}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  id,
  commit: c,
  graph,
  top,
  selected,
  head,
  mine,
  onBranch,
  opts,
  remoteNames,
  onPick,
}: {
  id: string;
  commit: Commit;
  graph: GraphRow | undefined;
  top: number;
  selected: boolean;
  head: boolean;
  mine: boolean;
  onBranch: boolean;
  opts: LogOptions;
  remoteNames: ReadonlySet<string>;
  onPick: (id: string, e: ReactMouseEvent) => void;
}) {
  const merge = opts.highlightMerges && c.parents.length > 1;
  const refs = c.refs.length > 0 && (
    <RefLabels
      refs={c.refs}
      compact={opts.compactRefs}
      tagNames={opts.tagNames}
      remoteNames={remoteNames}
      left={opts.refsOnLeft}
    />
  );
  const time = opts.commitTimestamp ? (c.commitTimeMs ?? c.timeMs) : c.timeMs;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={clsx(styles.row, onBranch && styles.currentBranch, selected && styles.selected)}
      style={{ top }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on range clicks
        onPick(commitKey(c), e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, commitMenu(c, selectedCommits()));
      }}
    >
      {commitRepo(c) && useVcs.getState().roots.length > 1 && (
        <span className={styles.colRepository} title={commitRepo(c)!}>
          {repoName(commitRepo(c)!)}
        </span>
      )}
      <span className={styles.colSubject}>
        {graph && <GraphCell row={graph} head={head} />}
        {opts.refsOnLeft && refs}
        <span
          className={clsx(styles.subject, head && styles.headSubject, merge && styles.mergeSubject)}
          title={c.message}
        >
          {c.summary}
        </span>
        {!opts.refsOnLeft && refs}
      </span>
      {opts.showAuthor && (
        <span className={clsx(styles.colAuthor, styles.muted, mine && styles.mine)} title={`${c.author} <${c.email}>`}>
          {c.author}
        </span>
      )}
      {opts.showDate && <span className={clsx(styles.colDate, styles.muted)}>{formatTime(time)}</span>}
      {opts.showHash && <span className={clsx(styles.colHash, styles.muted, styles.hash)}>{c.shortId}</span>}
    </div>
  );
});

function x(lane: number) {
  return LANE / 2 + lane * LANE;
}

function seg(fromX: number, fromY: number, toX: number, toY: number) {
  if (fromX === toX) return `M${fromX} ${fromY}L${toX} ${toY}`;
  const mid = (fromY + toY) / 2;
  return `M${fromX} ${fromY}C${fromX} ${mid} ${toX} ${mid} ${toX} ${toY}`;
}

export function GraphCell({ row, head }: { row: GraphRow; head?: boolean }) {
  const width = Math.min(row.width, 24) * LANE;
  const cy = ROW / 2;
  return (
    <svg className={styles.graph} width={width} height={ROW} aria-hidden>
      {row.up.map((s, i) => (
        <path
          key={`u${i}`}
          d={seg(x(s.from), 0, x(s.to), cy) + (s.arrow ? arrowHead(x(s.from), 0, -1) : "")}
          stroke={laneColor(s.color)}
          strokeLinecap={s.dashed ? "butt" : "square"}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {row.down.map((s, i) => (
        <path
          key={`d${i}`}
          d={seg(x(s.from), cy, x(s.to), ROW) + (s.arrow ? arrowHead(x(s.to), ROW, 1) : "")}
          stroke={laneColor(s.color)}
          strokeLinecap={s.dashed ? "butt" : "square"}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {head ? (
        <>
          <circle
            cx={x(row.lane)}
            cy={cy}
            r={5}
            fill="var(--log-row-bg, var(--bg-app))"
            stroke={laneColor(row.color)}
            strokeWidth={1.5}
          />
          <circle cx={x(row.lane)} cy={cy} r={2.5} fill={laneColor(row.color)} />
        </>
      ) : (
        <circle cx={x(row.lane)} cy={cy} r={3.8} fill={laneColor(row.color)} />
      )}
    </svg>
  );
}

/** Arrow head at (`px`, `py`) pointing up (`dir` -1) or down (1): a long edge continues. */
function arrowHead(px: number, py: number, dir: 1 | -1) {
  const back = py - dir * 4;
  return `M${px - 3} ${back}L${px} ${py}L${px + 3} ${back}`;
}

const REF_KIND_CLASS = {
  head: styles.refHead,
  local: styles.refLocal,
  remote: styles.refRemote,
  tag: styles.refTag,
};

const NO_REMOTES: ReadonlySet<string> = new Set();

export function RefLabels({
  refs,
  compact = false,
  tagNames = true,
  remoteNames = NO_REMOTES,
  left = false,
}: {
  refs: string[];
  compact?: boolean;
  tagNames?: boolean;
  remoteNames?: ReadonlySet<string>;
  left?: boolean;
}) {
  const labels = refLabels(refs, { compact, tagNames }, remoteNames);
  return (
    <span className={clsx(styles.refs, left && styles.refsLeft)}>
      {labels.map((l) => (
        <span key={`${l.kind}:${l.title}`} className={clsx(styles.ref, REF_KIND_CLASS[l.kind])} title={l.title}>
          {l.text}
        </span>
      ))}
    </span>
  );
}
