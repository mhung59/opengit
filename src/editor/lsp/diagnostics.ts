/**
 * Diagnostics in the editor: the backend pushes full per-(file, producer)
 * replacements (`IdeEvent::diagnostics`); each editor shows the union for its
 * path through `@codemirror/lint` (wavy underlines, no gutter, no lint
 * tooltip — `hover.ts` renders diagnostics together with documentation).
 */
import type { Diagnostic, Severity } from "@/bindings";
import { type ScrollbarMark } from "@/editor/api";
import { editorPrefs } from "@/platform/editorSettings";
import {
  applyProfile,
  diagnosticInspection,
  inspectionProfile,
  isTypoStyled,
  noteDiagnosticCodes,
  type InspectionRef,
} from "@/platform/inspections";
import { publishLocalDiagnostics } from "@/platform/localDiagnostics";
import { forEachDiagnostic, type Diagnostic as LintDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showHint } from "./hint";
import { rangeToOffsets } from "./positions";

type Listener = () => void;

const byPath = new Map<string, Map<string, Diagnostic[]>>();
const listeners = new Map<string, Set<Listener>>();

/** Diagnostics a UI-side inspection computed for `path` (shown in the editor and Problems). */
export function setFileDiagnostics(path: string, source: string, items: Diagnostic[]) {
  const had = byPath.get(path)?.has(source) ?? false;
  storeDiagnostics(path, source, items);
  // `server` names the producer for views that see the diagnostic alone (inspection controls).
  if (items.length || had)
    publishLocalDiagnostics(
      path,
      source,
      items.map((d) => (d.server ? d : { ...d, server: source })),
    );
}

function storeDiagnostics(path: string, source: string, items: Diagnostic[]) {
  let sources = byPath.get(path);
  if (!items.length) {
    if (!sources?.delete(source)) return;
    if (!sources.size) byPath.delete(path);
  } else {
    if (!sources) byPath.set(path, (sources = new Map()));
    sources.set(
      source,
      items.map((d) => ({ ...d, source: d.source ?? source })),
    );
    noteDiagnosticCodes(source, items);
  }
  listeners.get(path)?.forEach((l) => l());
}

/** Diagnostics of `path` under the inspection profile in effect. */
export function diagnosticsFor(path: string): Diagnostic[] {
  const sources = byPath.get(path);
  if (!sources) return [];
  const profile = inspectionProfile();
  return [...sources].flatMap(([source, items]) => applyProfile(profile, source, items));
}

/** Inspections reporting a problem at `pos` of `path` (profile applied), most severe first. */
export function inspectionsAt(path: string, doc: Text, pos: number): InspectionRef[] {
  const sources = byPath.get(path);
  if (!sources) return [];
  const profile = inspectionProfile();
  const found: { ref: InspectionRef; rank: number }[] = [];
  for (const [producer, items] of sources) {
    for (const d of applyProfile(profile, producer, items)) {
      const { from, to } = rangeToOffsets(doc, d.range);
      if (pos < from || pos > to) continue;
      const ref = diagnosticInspection(producer, d);
      if (ref && !found.some((f) => f.ref.id === ref.id)) found.push({ ref, rank: SEVERITY_RANK[d.severity] });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.ref);
}

export function subscribeDiagnostics(path: string, l: Listener): () => void {
  let set = listeners.get(path);
  if (!set) listeners.set(path, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size) listeners.delete(path);
  };
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Backend diagnostics → lint diagnostics for `doc` (empty ranges widened to one character). */
export function toLintDiagnostics(doc: Text, items: readonly Diagnostic[]): LintDiagnostic[] {
  const out: LintDiagnostic[] = items.map((d) => {
    let { from, to } = rangeToOffsets(doc, d.range);
    if (from === to) {
      const line = doc.lineAt(from);
      if (to < line.to) to++;
      else if (from > line.from) from--;
    }
    const classes = [
      d.unnecessary && "cm-lsp-unnecessary",
      d.deprecated && "cm-lsp-deprecated",
      isTypoStyled(d) && "cm-lsp-typo",
    ].filter(Boolean);
    return {
      from,
      to,
      severity: d.severity,
      message: d.message,
      source: [d.source, isInternalCode(d.code) ? null : d.code].filter(Boolean).join(" ") || undefined,
      markClass: classes.length ? classes.join(" ") : undefined,
    };
  });
  return out.sort((a, b) => a.from - b.from || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Problem ids that mean nothing to a reader (jdtls: `67109264`); short ones (TS `2322`) stay. */
const isInternalCode = (code: string | null | undefined) => !!code && /^\d{6,}$/.test(code);

const MARK_COLOR: Partial<Record<Severity, string>> = {
  error: "var(--danger)",
  warning: "var(--warning)",
  info: "var(--info)",
};

/** Overview-lane (scrollbar) marks for diagnostics, errors on top. */
export function diagnosticMarks(diags: readonly LintDiagnostic[]): ScrollbarMark[] {
  const out: ScrollbarMark[] = [];
  for (const d of diags) {
    const color = MARK_COLOR[d.severity];
    if (!color || d.markClass?.includes("cm-lsp-unnecessary") || d.markClass?.includes("cm-lsp-typo")) continue;
    out.push({ from: d.from, to: d.to, color, tooltip: d.message, priority: 3 - SEVERITY_RANK[d.severity] });
  }
  return out;
}

export interface PlacedDiagnostic {
  from: number;
  to: number;
  diagnostic: LintDiagnostic;
}

export function diagnosticsAt(view: EditorView, pos: number): PlacedDiagnostic[] {
  const out: PlacedDiagnostic[] = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    if (from <= pos && pos <= to) out.push({ from, to, diagnostic: d });
  });
  return out.sort((a, b) => SEVERITY_RANK[a.diagnostic.severity] - SEVERITY_RANK[b.diagnostic.severity]);
}

/**
 * F2 / ⇧F2: the next highlighted problem after (before) the caret, wrapping.
 * Like IDEA, errors take priority: warnings are visited only when the file has
 * no errors. Hints are skipped unless nothing else exists.
 */
export function gotoDiagnostic(view: EditorView, dir: 1 | -1): boolean {
  const all: PlacedDiagnostic[] = [];
  forEachDiagnostic(view.state, (d, from, to) => all.push({ from, to, diagnostic: d }));
  if (!all.length) {
    showHint(view, "No problems in this file");
    return false;
  }
  const best = Math.min(...all.map((p) => Math.min(SEVERITY_RANK[p.diagnostic.severity], 2)));
  // "Next error action goes to high priority problems only" (Code Editing).
  const highOnly = editorPrefs().codeEditing.nextErrorErrorsOnly;
  const list = all
    .filter((p) => (highOnly ? Math.min(SEVERITY_RANK[p.diagnostic.severity], 2) === best : true))
    .sort((a, b) => a.from - b.from);
  const head = view.state.selection.main.head;
  const target =
    dir === 1
      ? (list.find((p) => p.from > head) ?? list[0]!)
      : ([...list].reverse().find((p) => p.from < head && !(p.from <= head && head <= p.to)) ?? list[list.length - 1]!);
  view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true, userEvent: "select.navigate" });
  showHint(view, target.diagnostic.message, {
    pos: target.from,
    tone:
      target.diagnostic.severity === "error" ? "error" : target.diagnostic.severity === "warning" ? "warning" : "info",
    timeout: 6000,
  });
  return true;
}

/** ⌘F1 Show Error Description: the problems at the caret, worst first. */
export function showErrorDescription(view: EditorView): boolean {
  const at = diagnosticsAt(view, view.state.selection.main.head);
  if (!at.length) {
    showHint(view, "No problems at the caret");
    return false;
  }
  const worst = at[0]!.diagnostic.severity;
  showHint(view, [...new Set(at.map((p) => p.diagnostic.message))].join("\n"), {
    tone: worst === "error" ? "error" : worst === "warning" ? "warning" : "info",
    timeout: 10000,
  });
  return true;
}
