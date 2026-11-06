/** Git Log filters and graph/view options. */
import { tx } from "@/platform/i18n";
import { Icon, IconButton, SearchField, showContextMenu, type MenuItem } from "@/ui";
import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BranchFilterPopup } from "./BranchFilterPopup";
import styles from "./GitLog.module.css";
import { chooseDateRange, chooseMany, promptText } from "./dialogs";
import { useLogOptions, type LogOptions } from "./logOptions";
import { ME, dateRangeLabel, reloadLog, setLogBranches, setLogFilters, updateLogOptions, useGitLog } from "./logStore";
import { relTo } from "./model";
import { branchesByRepo } from "./multiRoot";
import { repoName, useVcs } from "./store";

// --- filters ----------------------------------------------------------------

const DAY = 86_400_000;

const DATE_OPTIONS: { label: string; days: number }[] = [
  { label: "Last 24 Hours", days: 1 },
  { label: "Last 7 Days", days: 7 },
  { label: "Last 30 Days", days: 30 },
  { label: "Last Year", days: 365 },
];

export function menuBelow(anchor: HTMLElement | ReactMouseEvent<HTMLElement>, items: MenuItem[]) {
  const r = ("currentTarget" in anchor ? anchor.currentTarget : anchor).getBoundingClientRect();
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
}

interface LogFilter {
  label: string;
  value: string | null;
  onOpen: (anchor: HTMLElement) => void;
  onClear: () => void;
}

function FilterButton({ label, value, onOpen, onClear, hidden }: LogFilter & { hidden?: boolean }) {
  return (
    <span
      className={clsx(styles.filterButton, value && styles.filterActive, hidden && styles.filterHidden)}
      inert={hidden}
    >
      <button type="button" className={styles.filterMain} onClick={(e) => onOpen(e.currentTarget)} aria-haspopup="menu">
        {value ? (
          <>
            {tx(label)}: <span className={styles.filterValue}>{value}</span>
          </>
        ) : (
          tx(label)
        )}
        {!value && <Icon name="chevron-down" size={12} className={styles.filterChevron} />}
      </button>
      {value && (
        <button
          type="button"
          className={styles.filterClear}
          aria-label={tx`Clear ${tx(label)} filter`}
          onClick={onClear}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export function FilterBar() {
  const filters = useGitLog((s) => s.filters);
  const commits = useGitLog((s) => s.commits);
  const selectedBranches = useVcs((s) => s.branches);
  const [branches, setBranches] = useState(selectedBranches);
  const version = useVcs((s) => s.version);
  const root = useVcs((s) => s.root);
  const repositories = useVcs((s) => s.roots);
  const showBranches = useLogOptions((s) => s.showBranches);
  useEffect(() => {
    let live = true;
    const roots = filters.repositories?.length ? filters.repositories : repositories;
    void branchesByRepo(roots)
      .then((all) => {
        if (live)
          setBranches([
            ...new Map(
              Object.values(all)
                .flat()
                .map((b) => [b.name, b]),
            ).values(),
          ]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repositories, filters.repositories, version]);
  const [text, setText] = useState(filters.text);
  const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);
  // Filters that do not fit move behind a chevron, like a toolbar's overflow.
  const groupRef = useRef<HTMLSpanElement>(null);
  const [hiddenFrom, setHiddenFrom] = useState(Infinity);
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => {
      const items = [...group.children] as HTMLElement[];
      const i = items.findIndex((el) => el.offsetLeft + el.offsetWidth > group.clientWidth + 1);
      setHiddenFrom(i < 0 ? Infinity : i);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(group);
    for (const el of group.children) ro.observe(el);
    return () => ro.disconnect();
  }, [filters, repositories.length]);

  // Keep the field in sync when filters change elsewhere (Show History, reveal).
  const [seen, setSeen] = useState(filters);
  if (seen !== filters) {
    setSeen(filters);
    setText(filters.text);
  }

  useEffect(() => {
    if (text === filters.text) return;
    const t = setTimeout(() => setLogFilters({ text }), 300);
    return () => clearTimeout(t);
  }, [text, filters.text]);

  const branchNames = () => branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name);

  const selectBranches = async () => {
    setBranchAnchor(null);
    const r = await chooseMany({
      title: "Filter by Branch",
      options: ["HEAD", ...branchNames()],
      initial: filters.branches,
      customLabel: "Other revisions (comma-separated):",
    });
    if (r) setLogBranches(r);
  };

  const openUser = (anchor: HTMLElement) => {
    const authors = [...new Set(commits.map((c) => c.author))].sort((a, b) => a.localeCompare(b)).slice(0, 30);
    menuBelow(anchor, [
      { label: ME, checked: filters.authors.includes(ME), run: () => setLogFilters({ authors: [ME] }) },
      ...(authors.length ? [{ kind: "separator" as const }] : []),
      ...authors.map((a) => ({
        label: a,
        checked: filters.authors.includes(a),
        run: () => setLogFilters({ authors: [a] }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseMany({
            title: "Filter by User",
            options: [ME, ...authors],
            initial: filters.authors,
            customLabel: "Other names or emails (comma-separated):",
          });
          if (r) setLogFilters({ authors: r });
        },
      },
    ]);
  };

  const openDate = (anchor: HTMLElement) =>
    menuBelow(anchor, [
      ...DATE_OPTIONS.map((o) => ({
        label: o.label,
        checked: filters.date?.label === o.label,
        run: () => setLogFilters({ date: { after: Date.now() - o.days * DAY, before: null, label: o.label } }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseDateRange();
          if (r) setLogFilters({ date: { ...r, label: dateRangeLabel(r.after, r.before) } });
        },
      },
    ]);

  const openPaths = (anchor: HTMLElement) =>
    menuBelow(anchor, [
      {
        label: "Select Folders…",
        run: async () => {
          const cur = filters.path && root ? relTo(root, filters.path) : (filters.path ?? "");
          const r = await promptText({ title: "Filter by Path", label: "File or folder", initial: cur, mono: true });
          if (!r) return;
          const v = r.value.trim();
          setLogFilters({ path: v ? (v.startsWith("/") || !root ? v : `${root}/${v}`) : null });
        },
      },
    ]);

  const logFilters: LogFilter[] = [
    ...(repositories.length > 1
      ? [
          {
            label: "Repository",
            value: filters.repositories?.map(repoName).join(", ") || null,
            onOpen: (anchor: HTMLElement) =>
              menuBelow(
                anchor,
                repositories.map((repo) => ({
                  label: repoName(repo),
                  checked: filters.repositories?.includes(repo) ?? false,
                  run: () => setLogFilters({ repositories: [repo] }),
                })),
              ),
            onClear: () => setLogFilters({ repositories: [] }),
          },
        ]
      : []),
    {
      label: "Branch",
      value: filters.branches.join(", ") || null,
      onOpen: setBranchAnchor,
      onClear: () => setLogBranches([]),
    },
    {
      label: "User",
      value: filters.authors.join(", ") || null,
      onOpen: openUser,
      onClear: () => setLogFilters({ authors: [] }),
    },
    {
      label: "Date",
      value: filters.date?.label ?? null,
      onOpen: openDate,
      onClear: () => setLogFilters({ date: null }),
    },
    {
      label: "Paths",
      value: filters.path ? (root ? relTo(root, filters.path) : filters.path) || "." : null,
      onOpen: openPaths,
      onClear: () => setLogFilters({ path: null }),
    },
  ];

  return (
    <div className={styles.filters} role="toolbar" aria-label={tx("Log filters")}>
      {!showBranches && (
        <IconButton icon="chevron-right" title="Show Branches" size="small" action="vcs.log.showBranches" />
      )}
      <SearchField
        className={styles.textFilter}
        value={text}
        onChange={setText}
        placeholder="Text or hash"
        aria-label="Filter by message"
        toggles={[
          {
            id: "regex",
            icon: "regex",
            title: "Regex",
            pressed: filters.regex,
            onToggle: (regex) => setLogFilters({ regex }),
          },
          {
            id: "case",
            icon: "case",
            title: "Match Case",
            pressed: filters.matchCase,
            onToggle: (matchCase) => setLogFilters({ matchCase }),
          },
        ]}
      />
      <span ref={groupRef} className={styles.filterGroup}>
        {logFilters.map((f, i) => (
          <FilterButton key={f.label} {...f} hidden={i >= hiddenFrom} />
        ))}
      </span>
      {hiddenFrom < logFilters.length && (
        <IconButton
          icon="chevron-right"
          title="More Filters"
          size="small"
          aria-haspopup="menu"
          onClick={(e) => {
            const anchor = e.currentTarget;
            menuBelow(
              anchor,
              logFilters.slice(hiddenFrom).map((f) => ({
                label: f.value ? `${tx(f.label)}: ${f.value}` : f.label,
                run: () => f.onOpen(anchor),
              })),
            );
          }}
        />
      )}
      {branchAnchor && (
        <BranchFilterPopup
          anchor={branchAnchor}
          branches={branches}
          selected={filters.branches}
          onClose={() => setBranchAnchor(null)}
          onSelect={(branch) => {
            setLogBranches([branch]);
            setBranchAnchor(null);
          }}
          onSelectMany={() => void selectBranches()}
        />
      )}
      <span className={styles.grow} />
      <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reloadLog({ preserve: true })} />
      <IconButton
        icon="sort"
        title="Graph Options"
        size="small"
        aria-haspopup="menu"
        onClick={(e) => menuBelow(e, graphOptionsMenu(useLogOptions.getState()))}
      />
      <IconButton
        icon="eye"
        title="View Options"
        size="small"
        aria-haspopup="menu"
        onClick={(e) => menuBelow(e, viewOptionsMenu(useLogOptions.getState()))}
      />
      <IconButton icon="search" title="Go to Hash/Branch/Tag" size="small" action="vcs.log.goToRef" />
    </div>
  );
}

const toggle = (label: string, o: LogOptions, key: keyof LogOptions): MenuItem => ({
  label,
  checked: !!o[key],
  run: () => updateLogOptions({ [key]: !o[key] }),
});

/** IDEA's Git Log › Graph Options (sort, first parent / no merges, linear branches). */
export function graphOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Sort" },
    { label: "By Commit Date", checked: o.sort === "date", run: () => updateLogOptions({ sort: "date" }) },
    { label: "Topologically", checked: o.sort === "topo", run: () => updateLogOptions({ sort: "topo" }) },
    { kind: "separator" },
    { kind: "header", label: "Options" },
    toggle("First Parent", o, "firstParent"),
    toggle("No Merges", o, "noMerges"),
    { kind: "separator" },
    { kind: "header", label: "Branch Actions" },
    { kind: "action", action: "vcs.log.collapseLinear" },
    { kind: "action", action: "vcs.log.expandLinear" },
  ];
}

/** IDEA's Git Log › View Options (what rows show and highlight). */
export function viewOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Show" },
    toggle("Compact References View", o, "compactRefs"),
    toggle("Tag Names", o, "tagNames"),
    toggle("Long Edges", o, "longEdges"),
    toggle("Commit Timestamp", o, "commitTimestamp"),
    toggle("References on the Left", o, "refsOnLeft"),
    {
      label: "Columns",
      submenu: [toggle("Author", o, "showAuthor"), toggle("Date", o, "showDate"), toggle("Hash", o, "showHash")],
    },
    { kind: "separator" },
    { kind: "header", label: "Highlight" },
    toggle("My Commits", o, "highlightMine"),
    toggle("Merge Commits", o, "highlightMerges"),
    toggle("Current Branch", o, "highlightCurrentBranch"),
  ];
}
