/**
 * Gutter icons for inheritance: "is implemented / overridden" (↓) on types and
 * methods with implementations or overriders, "implements / overrides" (↑) on
 * methods with a super method. Clicking one navigates to its single target or
 * opens the targets chooser.
 *
 * Generic over language servers: ↓ comes from implementation requests (one
 * cancellable batch per pass), ↑ from the type hierarchy and the supertypes'
 * document symbols (as Super Method, ⌘U). Only declarations in and near the
 * viewport are asked, in one debounced pass after edits / scrolling; results
 * are cached per document text, and markers follow their lines in between.
 */
import { isUnavailable } from "@/editor/lsp/lsp";
import { locationItems, navigateTo, pinToFind } from "@/editor/lsp/navigation";
import { openPopup } from "@/editor/lsp/popupStore";
import { type EditorExtras } from "@/platform/editorSettings";
import { isCancelled, type Location, type Pos } from "@/platform/ipc";
import {
  candidateKey,
  inheritorsMarker,
  supersMarker,
  withoutSelf,
  type LineMarker,
  type MarkerCandidate,
  type MarkerGroup,
} from "./lineMarkers";
import { superMethodTargets, type SuperDeps, type SuperMethod } from "./structureNav";

/** Settings › Editor › General › Gutter Icons groups that are on. */
export function enabledGroups(prefs: Pick<EditorExtras, "showGutterIcons" | "gutterIconsDisabled">): Set<MarkerGroup> {
  if (!prefs.showGutterIcons) return new Set();
  return new Set((["inheritors", "supers"] as const).filter((g) => !prefs.gutterIconsDisabled.includes(g)));
}

export interface MarkerDeps {
  /** Implementations of the symbols at `positions`, one list each (rejects when the server cannot answer). */
  implementations: (positions: Pos[]) => Promise<Location[][]>;
  supers: SuperDeps;
  readFiles: (paths: readonly string[]) => Promise<Map<string, string[] | null>>;
}

interface CacheEntry {
  inheritors?: LineMarker | null;
  supers?: LineMarker | null;
}

/** Results for one document text; `unsupported` remembers a server that cannot answer a group. */
export interface MarkerCache {
  entries: Map<string, CacheEntry>;
  unsupported: Set<MarkerGroup>;
}

export const emptyCache = (): MarkerCache => ({ entries: new Map(), unsupported: new Set() });

/**
 * Asks the server about the `candidates` not in `cache` yet (only the enabled
 * `groups`) and stores the answers. Cancellation propagates; an unavailable
 * server marks its group unsupported for this cache.
 */
export async function fillMarkers(
  path: string,
  candidates: readonly MarkerCandidate[],
  groups: ReadonlySet<MarkerGroup>,
  deps: MarkerDeps,
  cache: MarkerCache,
): Promise<void> {
  const entry = (c: MarkerCandidate) => {
    const key = candidateKey(c);
    let e = cache.entries.get(key);
    if (!e) cache.entries.set(key, (e = {}));
    return e;
  };
  const down =
    groups.has("inheritors") && !cache.unsupported.has("inheritors")
      ? candidates.filter((c) => c.inheritable && cache.entries.get(candidateKey(c))?.inheritors === undefined)
      : [];
  const up =
    groups.has("supers") && !cache.unsupported.has("supers")
      ? candidates.filter((c) => c.overriding && c.owner && cache.entries.get(candidateKey(c))?.supers === undefined)
      : [];

  let implementations: Location[][] = [];
  if (down.length) {
    try {
      implementations = (await deps.implementations(down.map((c) => ({ line: c.line, col: c.col })))).map((locs, i) =>
        withoutSelf(path, down[i]!, locs),
      );
    } catch (e) {
      if (isCancelled(e)) throw e;
      if (isUnavailable(e)) cache.unsupported.add("inheritors");
      down.length = 0;
    }
  }
  const supers: SuperMethod[][] = [];
  for (const c of up) supers.push(await superMethodTargets(path, c.owner!, c.symbol, deps.supers));

  const files = await deps.readFiles([
    ...implementations.flat().map((l) => l.path),
    ...supers.flat().map((s) => s.location.path),
  ]);
  down.forEach((c, i) => (entry(c).inheritors = inheritorsMarker(c, implementations[i] ?? [], files)));
  up.forEach((c, i) => (entry(c).supers = supersMarker(c, supers[i]!, files)));
}

/** Markers known for `candidates`, in document order (↓ before ↑ on a line). */
export function cachedMarkers(
  candidates: readonly MarkerCandidate[],
  groups: ReadonlySet<MarkerGroup>,
  cache: MarkerCache,
): LineMarker[] {
  const out: LineMarker[] = [];
  for (const c of candidates) {
    const e = cache.entries.get(candidateKey(c));
    if (!e) continue;
    if (groups.has("inheritors") && e.inheritors) out.push(e.inheritors);
    if (groups.has("supers") && e.supers) out.push(e.supers);
  }
  return out;
}

/** Opens the single target, or the chooser over several. */
export async function openMarkerTargets(marker: LineMarker, anchor: { x: number; y: number }) {
  if (marker.targets.length === 1) {
    await navigateTo(marker.targets[0]!);
    return;
  }
  openPopup({
    kind: "list",
    anchor,
    title: marker.chooserTitle,
    items: await locationItems(marker.targets),
    pin: pinToFind(marker.name, marker.targets),
  });
}
