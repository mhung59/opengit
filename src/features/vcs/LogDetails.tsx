/** Selected commit details, message and changed files. */
import { RefLabels } from "./LogCommits";
import { menuBelow } from "./LogFilters";
import type { ChangedFile, Commit, RevisionChange } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
} from "@/ui";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";
import clsx from "clsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { DIFF_KIND, diffInput } from "./diffInput";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import styles from "./GitLog.module.css";
import { IssueText } from "./issueLinks";
import {
  absolutePath,
  filesUnder,
  flatFileNodes,
  showChangesDiff,
  toLogChanges,
  useLogChanges,
  type LogChange,
} from "./logChanges";
import { logOptions, useLogOptions } from "./logOptions";
import { useGitLog } from "./logStore";
import { KIND_COLOR, baseName, dirName, fileCount, relTo, type EffectiveKind } from "./model";
import { commitKey, commitRepo } from "./multiRoot";
import { currentRepo, useVcs } from "./store";

/** Keyboard moves through several files quickly: preview the one the selection settles on. */
const PREVIEW_DELAY = 120;

function fileNodeAt<F>(nodes: readonly FileTreeNode<F>[], key: string): FileTreeNode<F> | null {
  for (const n of nodes) {
    if (n.key === key) return n.file ? n : null;
    if (!n.file) {
      const hit = fileNodeAt(n.children, key);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The selected commits' changes: one commit's files against its first parent, or, for several
 * (IDEA), their combined changes with every selected commit listed below.
 */
export function CommitDetails({ commits }: { commits: Commit[] }) {
  const selected = useGitLog((s) => s.selected);
  const selection = useGitLog((s) => s.selection);
  // Newest first (log order).
  const chosen = useMemo(() => {
    const ids = new Set(selection);
    return commits.filter((c) => ids.has(commitKey(c)));
  }, [commits, selection]);
  const commit = selected ? commits.find((c) => commitKey(c) === selected) : undefined;
  const many = chosen.length > 1;
  const revisionIds = JSON.stringify(chosen.map((c) => c.id));
  const commitRoot = commit ? commitRepo(commit) : null;
  const root = useVcs((s) => s.root) ?? "";
  const [files, setFiles] = useState<(ChangedFile | RevisionChange)[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  useEffect(() => {
    const ids = JSON.parse(revisionIds) as string[];
    if (!ids.length) return;
    let alive = true;
    const load =
      ids.length > 1
        ? call(commands.vcsCommitsChanges(commitRoot ?? currentRepo(), ids.reverse()))
        : call(commands.vcsCommitFiles(commitRoot ?? currentRepo(), ids[0]!));
    load.then((f) => alive && setFiles(f)).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [revisionIds, commitRoot]);

  const groupByDirectory = useLogOptions((s) => s.groupByDirectory);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const treeRef = useRef<TreeHandle>(null);
  const [diffToReveal, setDiffToReveal] = useState<{ key: string } | null>(null);
  const syncingDiff = useRef(false);
  const changes = useMemo(
    () => (files && commit ? toLogChanges(files, many ? null : commit, commitRoot) : []),
    [files, commit, many, commitRoot],
  );
  const tree = useMemo(
    () =>
      groupByDirectory
        ? buildFileTree(changes, (f) => relTo(root, f.path))
        : flatFileNodes(changes, (f) => relTo(root, f.path)),
    [changes, root, groupByDirectory],
  );
  const allDirs = useMemo(() => dirKeys(tree), [tree]);
  const ordered = useMemo(() => filesUnder(tree), [tree]);
  const chosenChanges = useMemo(() => filesUnder(tree, selectedKeys), [tree, selectedKeys]);

  // Show Diff Preview: a single selected file follows into the editor's preview tab.
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const previewSelection = (sel: ReadonlySet<string>) => {
    clearTimeout(previewTimer.current);
    if (syncingDiff.current) return;
    if (!logOptions().diffPreview || sel.size !== 1) return;
    const file = fileNodeAt(tree, [...sel][0]!)?.file;
    // A preview that cannot open (no editor yet, the file went away) is just skipped.
    if (file)
      previewTimer.current = setTimeout(() => void showChangesDiff([file], true).catch(() => undefined), PREVIEW_DELAY);
  };

  // Follow only this pane's exact diff (path AND revisions); another commit or
  // Compare with Local must not move its selection. Never take focus from F7.
  useEffect(() => {
    const editor = maybeEditorService();
    const followDiff = (input: EditorInput | null) => {
      if (input?.kind !== DIFF_KIND) return;
      const change = ordered.find((c) => diffInput(c.diff).key === input.key);
      if (!change) return;
      clearTimeout(previewTimer.current);
      const rel = relTo(root, change.path);
      setExpanded((current) => {
        const next = new Set(current ?? allDirs);
        for (const key of allDirs) if (rel.startsWith(key.slice(2) + "/")) next.add(key);
        return next;
      });
      setDiffToReveal({ key: `f:${rel}` });
    };
    followDiff(editor?.activeInput?.() ?? null);
    return editor?.onActiveInputChange?.(followDiff);
  }, [ordered, allDirs, root]);

  // Tree.reveal needs the expanded rows to have rendered. Suppress the reverse
  // preview update so it cannot reopen the diff and lose its requested chunk.
  useLayoutEffect(() => {
    if (!diffToReveal) return;
    syncingDiff.current = true;
    treeRef.current?.reveal(diffToReveal.key);
    syncingDiff.current = false;
  }, [diffToReveal]);

  useEffect(() => {
    useLogChanges.setState({ commits: chosen, all: ordered, selected: chosenChanges });
  }, [chosen, ordered, chosenChanges]);
  useEffect(() => () => useLogChanges.setState({ commits: [], all: [], selected: [] }), []);

  if (!commit)
    return (
      <div className={styles.details}>
        <EmptyState>
          <T>Select a commit to view changes</T>
        </EmptyState>
      </div>
    );

  const openViewOptions = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      { kind: "header", label: "Group By" },
      { kind: "action", action: "vcs.log.changes.groupByDirectory" },
      { kind: "separator" },
      { kind: "action", action: "vcs.log.changes.diffPreview" },
    ]);

  const onFileMenu = (node: FileTreeNode<LogChange> | null, sel: ReadonlySet<string>, e: ReactMouseEvent) => {
    if (!node) return;
    const target = sel.has(node.key) ? filesUnder(tree, sel) : filesUnder([node]);
    if (!target.length) return;
    e.preventDefault();
    showContextMenu(e, changesMenu(target));
  };

  return (
    <div className={styles.details}>
      <SplitGroup orientation="vertical" id="git-log-details">
        <SplitPanel id="files" defaultSize="60%" minSize="60px">
          <div className={styles.filesPane}>
            <div className={styles.detailsBar} role="toolbar" aria-label={tx("Changed files")}>
              <IconButton
                icon="diff"
                size="small"
                title="Show Diff"
                action="vcs.log.changes.showDiff"
                actionArg={chosenChanges}
                disabled={!chosenChanges.length}
              />
              <IconButton
                icon="revert"
                size="small"
                title="Revert Selected Changes"
                action="vcs.log.changes.revert"
                actionArg={chosenChanges}
                disabled={!chosenChanges.length}
              />
              <IconButton icon="eye" title="View Options" size="small" aria-haspopup="menu" onClick={openViewOptions} />
              <span className={styles.detailsCount}>
                {files ? fileCount(files.length) : ""}
                {many ? " " + tx`in ${chosen.length} commits` : ""}
              </span>
              <span className={styles.grow} />
              <IconButton
                icon="expand-all"
                title="Expand All"
                size="small"
                disabled={!allDirs.length}
                onClick={() => setExpanded(new Set(allDirs))}
              />
              <IconButton
                icon="collapse-all"
                title="Collapse All"
                size="small"
                disabled={!allDirs.length}
                onClick={() => setExpanded(new Set())}
              />
            </div>
            {error && <div className={styles.message}>{error}</div>}
            {!files && !error && (
              <div className={styles.message}>
                <Spinner size={12} />
              </div>
            )}
            {files && (
              <Tree<FileTreeNode<LogChange>>
                handleRef={treeRef}
                roots={tree}
                getKey={(n) => n.key}
                getLabel={(n) => n.name}
                getChildren={(n) => (n.file ? undefined : n.children)}
                isExpandable={(n) => !n.file}
                expanded={expanded ?? new Set(allDirs)}
                onExpandedChange={(next) => setExpanded(next)}
                selected={selectedKeys}
                onSelectionChange={(sel) => {
                  setSelectedKeys(sel);
                  previewSelection(sel);
                }}
                renderNode={(n) => <ChangedFileRow node={n} flat={!groupByDirectory} />}
                onActivate={(n) => n.file && void showChangesDiff([n.file])}
                onContextMenu={onFileMenu}
                aria-label="Changed files"
                className={styles.fileTree}
              />
            )}
          </div>
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="message" minSize="60px">
          <div className={styles.messageBox}>
            {many ? (
              chosen.map((c) => <CommitMessage key={commitKey(c)} commit={c} compact />)
            ) : (
              <CommitMessage commit={commit} />
            )}
          </div>
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

/** A commit's message and metadata; `compact` (one of several selected): without the body. */
function CommitMessage({ commit, compact = false }: { commit: Commit; compact?: boolean }) {
  const [subject, ...bodyLines] = commit.message.replace(/\s+$/, "").split("\n");
  const body = compact ? "" : bodyLines.join("\n").replace(/^\n+/, "");
  return (
    <div className={clsx(compact && styles.commitEntry)}>
      <div className={styles.subjectLine}>
        <IssueText text={subject ?? ""} />
      </div>
      {body && (
        <div className={styles.fullMessage}>
          <IssueText text={body} />
        </div>
      )}
      <div className={clsx(styles.meta, compact && styles.metaCompact)}>
        <button
          type="button"
          className={clsx(styles.linkButton, styles.hash)}
          title={tx("Copy revision number")}
          onClick={() => void navigator.clipboard?.writeText(commit.id)}
        >
          {commit.shortId}
        </button>{" "}
        {commit.author} &lt;{commit.email}&gt;
        {commit.timeMs ? " " + tx`on ${new Date(commit.timeMs).toLocaleString()}` : ""}
      </div>
      {commit.parents.length > 1 && (
        <div className={styles.meta}>{tx`Merge of ${commit.parents.map((p) => p.slice(0, 8)).join(", ")}`}</div>
      )}
      {commit.refs.length > 0 && (
        <div className={styles.meta}>
          <RefLabels refs={commit.refs} />
        </div>
      )}
    </div>
  );
}

/** IDEA's changes browser context menu in the Git Log; `changes` = the files it acts on. */
export function changesMenu(changes: LogChange[]): MenuItem[] {
  const one = changes.length === 1 ? changes[0]! : null;
  return [
    { kind: "action", action: "vcs.log.changes.showDiff", arg: changes },
    { kind: "action", action: "vcs.log.changes.compareWithLocal", arg: changes, disabled: !one?.after },
    { kind: "action", action: "vcs.log.changes.compareBeforeWithLocal", arg: changes, disabled: !one?.before },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.changes.jumpToSource",
      arg: changes,
      disabled: !changes.some((c) => c.after),
    },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.changes.revert", arg: changes },
    { kind: "action", action: "vcs.log.changes.getFromRevision", arg: changes },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.showHistory",
      arg: one ? absolutePath(one.path, one.repo) : undefined,
      disabled: !one?.after,
    },
  ];
}

function ChangedFileRow({ node, flat = false }: { node: FileTreeNode<ChangedFile | LogChange>; flat?: boolean }) {
  if (!node.file)
    return (
      <span className={styles.fileRow}>
        <Icon name="folder" size={16} className={styles.fileIcon} />
        <span className={styles.fileName}>{node.name}</span>
        <span className={styles.fileDir}>{fileCount(node.count)}</span>
      </span>
    );
  const f = node.file;
  const kind: EffectiveKind = f.kind === "untracked" ? "added" : f.kind;
  return (
    <span className={styles.fileRow} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <Icon name={fileIconName(node.name)} size={16} className={styles.fileIcon} />
      <span className={styles.fileName} style={{ color: KIND_COLOR[kind] }}>
        {node.name}
      </span>
      {flat && dirName(f.path) && <span className={styles.fileDir}>{dirName(f.path)}</span>}
      {f.oldPath && <span className={styles.fileDir}>{tx`renamed from ${baseName(f.oldPath)}`}</span>}
    </span>
  );
}
