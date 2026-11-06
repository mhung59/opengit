/** Additional roots contributed to the project tree. */
import { create } from "zustand";

// ---------------------------------------------------------------------------
// Project view roots shown below the project ("External Libraries", "Scratches").

export interface ProjectViewRootEntry {
  label: string;
  /** Icon name from `ui/icons`. */
  icon: string;
  /** Folder whose contents the node lists (outside the project); omitted for a group of `children`. */
  path?: string;
  /** Child nodes of a group node (one per SDK, then its library folders). */
  children?: readonly ProjectViewRootEntry[];
  /** Grey text after the label ("library root"). */
  detail?: string;
  /** Library sources: shown read-only (no new / rename / move / delete). */
  readOnly?: boolean;
}

export interface ProjectViewRootContribution extends ProjectViewRootEntry {
  id: string;
  /** Lower first. */
  order?: number;
  /** Which project view mode lists it besides "Project" ("Scratches and Consoles"). */
  scope?: "scratches";
}

export const useProjectViewRoots = create<{ roots: Map<string, ProjectViewRootContribution> }>(() => ({
  roots: new Map(),
}));

export function registerProjectViewRoot(root: ProjectViewRootContribution): () => void {
  useProjectViewRoots.setState((s) => ({ roots: new Map(s.roots).set(root.id, root) }));
  return () =>
    useProjectViewRoots.setState((s) => {
      if (s.roots.get(root.id) !== root) return s;
      const roots = new Map(s.roots);
      roots.delete(root.id);
      return { roots };
    });
}

/** Registered project view roots in display order. */
export function projectViewRoots(map: ReadonlyMap<string, ProjectViewRootContribution>): ProjectViewRootContribution[] {
  return [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}
