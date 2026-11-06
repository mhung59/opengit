import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { Checkbox, Dialog, HighlightedText, IconButton, SymbolBadge, Tree, type TreeHandle } from "@/ui";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { badgeKind, basename, openLocation } from "../common/open";
import { useTracking } from "../common/tracking";
import {
  allKeys,
  applyViewFilter,
  filterOutline,
  hasFields,
  hasVisibility,
  keyOutline,
  parentKeys,
  sortOutline,
  symbolPathAt,
  visibleCount,
  withInherited,
  type OutlineNode,
} from "./outline";
import { useLiveOutline, useOutline, useStructureOptions } from "./store";
import styles from "./StructureView.module.css";

function useOutlineNodes() {
  const items = useOutline((s) => s.items);
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const byVisibility = useStructureOptions((s) => s.sortByVisibility);
  const fields = useStructureOptions((s) => s.showFields);
  const nonPublic = useStructureOptions((s) => s.showNonPublic);
  const showInherited = useStructureOptions((s) => s.showInherited);
  const supported = useOutline((s) => s.inheritedSupported);
  const inherited = useOutline((s) => s.inherited);
  const extra = showInherited && supported ? inherited : null;
  return useMemo(
    () =>
      sortOutline(
        applyViewFilter(withInherited(keyOutline(items ?? []), extra), { fields, nonPublic }),
        alphabetical,
        byVisibility,
      ),
    [items, extra, alphabetical, byVisibility, fields, nonPublic],
  );
}

const navigate = (path: string, node: OutlineNode, focus: boolean) => {
  const p = node.item.selection_range.start;
  void openLocation(node.inherited?.path ?? path, { line: p.line, col: p.col }, { focus });
};

/** A symbol row; inherited members are greyed and name their supertype. */
function SymbolRow({
  node,
  indices,
  selected,
  dim,
}: {
  node: OutlineNode;
  indices?: readonly number[] | null;
  selected: boolean;
  dim?: boolean;
}) {
  return (
    <span className={clsx(styles.node, dim && styles.ancestor, node.inherited && styles.inherited)}>
      <SymbolBadge kind={badgeKind(node.item.kind)} className={styles.badge} />
      <HighlightedText
        className={styles.name}
        text={node.item.name}
        indices={indices}
        tone={selected ? "accent" : "strong"}
      />
      {node.item.detail && <span className={styles.detail}>{node.item.detail}</span>}
      {node.inherited && <span className={styles.detail}>{`↑${node.inherited.owner}`}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ⌘F12 File Structure popup

export const useFileStructurePopup = create<{ open: boolean }>(() => ({ open: false }));

export function FileStructureOverlay() {
  const open = useFileStructurePopup((s) => s.open);
  return open ? <FileStructureDialog /> : null;
}

const POPUP_ROW = 22;

function FileStructureDialog() {
  useLiveOutline();
  const path = useOutline((s) => s.path);
  const items = useOutline((s) => s.items);
  const loading = useOutline((s) => s.loading);
  const alphabetical = useStructureOptions((s) => s.alphabetical);
  const narrowDown = useStructureOptions((s) => s.narrowDown);
  const showFields = useStructureOptions((s) => s.showFields);
  const showNonPublic = useStructureOptions((s) => s.showNonPublic);
  const showInherited = useStructureOptions((s) => s.showInherited);
  const inheritedSupported = useOutline((s) => s.inheritedSupported);
  const nodes = useOutlineNodes();
  const [query, setQuery] = useState("");
  // IDEA opens the popup fully expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const caret = useMemo(() => useTracking.getState().caret, []);
  const tree = useRef<TreeHandle>(null);

  const filter = useMemo(() => filterOutline(nodes, query, narrowDown), [nodes, query, narrowDown]);
  const parents = useMemo(() => parentKeys(filter.nodes), [filter.nodes]);
  const byKey = useMemo(() => {
    const m = new Map<string, OutlineNode>();
    const walk = (list: readonly OutlineNode[]) => list.forEach((n) => (m.set(n.key, n), walk(n.children)));
    walk(filter.nodes);
    return m;
  }, [filter.nodes]);
  const expanded = useMemo(
    () => new Set(allKeys(filter.nodes).filter((k) => !collapsed.has(k))),
    [filter.nodes, collapsed],
  );

  // Preselect the symbol at the caret, then the best match while filtering.
  const caretKey = useMemo(
    () =>
      caret && caret.path === path ? (symbolPathAt(nodes, { line: caret.line, col: caret.col }).pop() ?? null) : null,
    [caret, path, nodes],
  );
  const preselect = query.trim() ? filter.best : caretKey;
  useEffect(() => {
    const key = preselect ?? filter.nodes[0]?.key;
    if (key) tree.current?.reveal(key);
  }, [preselect, filter.nodes]);

  const close = () => useFileStructurePopup.setState({ open: false });
  const choose = (node: OutlineNode | undefined) => {
    if (!node || !path) return;
    close();
    setTimeout(() => navigate(path, node, true), 0);
  };
  const setExpanded = (key: string, open: boolean) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const lead = tree.current?.leadKey() ?? null;
    const node = lead ? byKey.get(lead) : undefined;
    switch (e.key) {
      case "Enter":
        choose(node);
        break;
      case "Escape":
        // The first Esc clears the filter, the next one closes the popup.
        if (!query) return;
        e.stopPropagation();
        setQuery("");
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (query.trim() && !narrowDown && filter.order.length) {
          // Highlight mode: ↑/↓ jump between matches.
          const at = lead ? filter.order.indexOf(lead) : -1;
          const n = filter.order.length;
          const next = filter.order[at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n]!;
          for (let p = parents.get(next); p; p = parents.get(p) ?? null) if (collapsed.has(p)) setExpanded(p, true);
          setTimeout(() => tree.current?.reveal(next), 0);
        } else tree.current?.moveSelection(dir);
        break;
      }
      case "ArrowRight":
        if (!node || !node.children.length) return;
        if (!expanded.has(node.key)) setExpanded(node.key, true);
        else tree.current?.reveal(node.children[0]!.key);
        break;
      case "ArrowLeft": {
        if (!node) return;
        if (node.children.length && expanded.has(node.key)) setExpanded(node.key, false);
        else {
          const parent = parents.get(node.key);
          if (parent) tree.current?.reveal(parent);
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const height = Math.min(420, Math.max(1, visibleCount(filter.nodes, collapsed)) * POPUP_ROW + 8);
  return (
    <Dialog
      open
      onClose={close}
      width={460}
      position="top"
      transparentBackdrop
      aria-label="File Structure"
      title={
        <span className={styles.popupTitle}>
          {path ? basename(path) : tx("File Structure")}
          <span className={styles.popupHint}>{shortcutLabel("navigate.fileStructure")}</span>
        </span>
      }
    >
      <div className={styles.filterRow}>
        <input
          data-autofocus
          className={styles.filter}
          value={query}
          placeholder={path ? "Type to filter symbols" : "No active editor"}
          aria-label={tx("Filter symbols")}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setCollapsed(new Set());
          }}
          onKeyDown={onKeyDown}
        />
        <IconButton
          icon="sort"
          title="Sort Alphabetically"
          size="small"
          pressed={alphabetical}
          onClick={() => useStructureOptions.setState({ alphabetical: !alphabetical })}
        />
      </div>
      <div className={styles.popupOptions}>
        <Checkbox
          label="Narrow down on typing"
          checked={narrowDown}
          onChange={(v) => useStructureOptions.setState({ narrowDown: v })}
        />
        {(hasFields(items ?? []) || !showFields) && (
          <Checkbox
            label="Show fields"
            checked={showFields}
            onChange={(v) => useStructureOptions.setState({ showFields: v })}
          />
        )}
        {hasVisibility(items ?? []) && (
          <Checkbox
            label="Show non-public"
            checked={showNonPublic}
            onChange={(v) => useStructureOptions.setState({ showNonPublic: v })}
          />
        )}
        {inheritedSupported && (
          <Checkbox
            label="Show inherited members"
            checked={showInherited}
            onChange={(v) => useStructureOptions.setState({ showInherited: v })}
          />
        )}
      </div>
      <div className={styles.popupList} style={{ height }}>
        <Tree<OutlineNode>
          handleRef={tree}
          aria-label="Symbols"
          roots={filter.nodes}
          getKey={(n) => n.key}
          getLabel={(n) => n.item.name}
          getChildren={(n) => (n.children.length ? n.children : undefined)}
          isExpandable={(n) => n.children.length > 0}
          expanded={expanded}
          onExpandedChange={(_next, n, open) => setExpanded(n.key, open)}
          multiSelect={false}
          speedSearch={false}
          activateExpandable
          onActivate={(n) => choose(n)}
          rowHeight={POPUP_ROW}
          indent={16}
          empty={
            <span className={styles.popupEmpty}>
              {!path ? tx("Open a file first") : loading && !items ? tx("Loading…") : tx("No symbols")}
            </span>
          }
          renderNode={(n, s) => {
            const matched = filter.matches.get(n.key);
            return <SymbolRow node={n} indices={matched} selected={s.selected} dim={!!query.trim() && !matched} />;
          }}
        />
      </div>
    </Dialog>
  );
}
