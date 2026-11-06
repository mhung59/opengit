/** Shared VCS and diagnostic file decorations. */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// ---------------------------------------------------------------------------
// File decorations: colour / badge / tooltip for a path, shown by the project
// tree, editor tabs, Search Everywhere, etc. Providers (VCS status, problems)
// push decorations into this store; consumers read with `useFileDecoration`.

export interface FileDecoration {
  /** CSS colour, normally a token like `var(--vcs-modified)`. */
  color?: string;
  /** CSS colour tinting the editor tab (a data source's colour on its console). */
  tint?: string;
  /** Short badge text, e.g. a problem count. */
  badge?: string;
  tooltip?: string;
  /** Wavy-underline style emphasis for files with errors (IDEA red underline). */
  error?: boolean;
  /** Dim the entry (ignored/excluded). */
  faded?: boolean;
  /** Also decorate ancestor folders (VCS changes, errors). */
  propagate?: boolean;
  /** The path is a folder whose whole content shares this decoration (untracked / ignored folder). */
  subtree?: boolean;
}

interface FileDecorationsState {
  /** provider id → (path → decoration). Later providers win per field. */
  providers: Map<string, Map<string, FileDecoration>>;
  /** Folder paths that contain decorated descendants, per provider. */
  folders: Map<string, Map<string, FileDecoration>>;
  /** `subtree` decorations per provider: folder → decoration for everything below it. */
  subtrees: Map<string, Map<string, FileDecoration>>;
}

export const useFileDecorations = create<FileDecorationsState>(() => ({
  providers: new Map(),
  folders: new Map(),
  subtrees: new Map(),
}));

const providerOrder = ["vcs", "problems"];

/** Replaces all decorations of one provider. */
export function setFileDecorations(provider: string, decorations: Map<string, FileDecoration>) {
  const folders = new Map<string, FileDecoration>();
  const subtrees = new Map<string, FileDecoration>();
  for (const [path, d] of decorations) {
    if (d.subtree) subtrees.set(path, { color: d.color, tooltip: d.tooltip, faded: d.faded, error: d.error });
    if (!d.propagate) continue;
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
      const dir = path.slice(0, i);
      const prev = folders.get(dir);
      folders.set(dir, { color: prev?.color ?? d.color, error: prev?.error || d.error });
    }
  }
  useFileDecorations.setState((s) => ({
    providers: new Map(s.providers).set(provider, decorations),
    folders: new Map(s.folders).set(provider, folders),
    subtrees: new Map(s.subtrees).set(provider, subtrees),
  }));
}

/** Nearest `subtree` decoration of an ancestor folder of `path`. */
function inherited(path: string, subtrees: Map<string, FileDecoration> | undefined): FileDecoration | undefined {
  if (!subtrees?.size) return undefined;
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const d = subtrees.get(path.slice(0, i));
    if (d) return d;
  }
  return undefined;
}

function merged(path: string, s: FileDecorationsState): FileDecoration | undefined {
  let out: FileDecoration | undefined;
  const ids = [...s.providers.keys()].sort((a, b) => providerOrder.indexOf(a) - providerOrder.indexOf(b));
  for (const id of ids) {
    const d = s.providers.get(id)?.get(path) ?? s.folders.get(id)?.get(path) ?? inherited(path, s.subtrees.get(id));
    if (d) out = { ...out, ...d };
  }
  return out;
}

export function getFileDecoration(path: string): FileDecoration | undefined {
  return merged(path, useFileDecorations.getState());
}

const NONE: FileDecoration = {};

/** Reactive decoration for `path` (empty object when undecorated). */
export function useFileDecoration(path: string): FileDecoration {
  return useFileDecorations(useShallow((s) => merged(path, s) ?? NONE));
}
