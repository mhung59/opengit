/** Editor input identities, reactive tab state and tab presentation. */
import type { VirtualDocument } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { fileIconName } from "@/ui";
import { useContributions, type EditorInput } from "@/workbench/contributions";
import { create } from "zustand";
import { EditorSlot } from "./model/slot";
import { initialTabsState, paneIds, type Tab, type TabsState } from "./model/tabs";

export const fileKey = (path: string) => `file:${path}`;

export const fileInput = (path: string): EditorInput => ({ kind: "file", key: fileKey(path), path });

/** `data` of a `virtual` editor input: what the tab and its notice show. */
export interface VirtualInputData {
  title: string;
  description: string | null;
  decompiled: boolean;
}

export const virtualKey = (uri: string) => `virtual:${uri}`;

/**
 * A read-only virtual document (library class from a language server). Its
 * `path` is the URI, which also identifies its document model.
 */
export const virtualInput = (
  vd: Pick<VirtualDocument, "uri" | "title" | "description" | "decompiled">,
): EditorInput => ({
  kind: "virtual",
  key: virtualKey(vd.uri),
  path: vd.uri,
  data: { title: vd.title, description: vd.description, decompiled: vd.decompiled } satisfies VirtualInputData,
});

/** Inputs shown in the text editor: files and virtual documents. */
export function isTextInput(input: EditorInput): input is EditorInput & { path: string } {
  return (input.kind === "file" || input.kind === "virtual") && !!input.path;
}

export const useTabs = create<TabsState>(() => initialTabsState());

/** Session key of the LightEdit window: its tabs reopen the next time a window switches to LightEdit. */
export const LIGHT_EDIT_SESSION = "<lightEdit>";

export interface EditorStatus {
  path: string;
  doc: number;
  /** 0-based */
  line: number;
  col: number;
  offset: number;
  selectedChars: number;
  selectedLines: number;
  carets: number;
}

export const useEditorStatus = create<{ status: EditorStatus | null }>(() => ({ status: null }));

/** Per-tab open errors (file missing, too large…). */
export const useTabErrors = create<Record<string, string>>(() => ({}));

/** Per-pane find bar state (open / replace mode); the bar keeps its own query. */
export const useFindBars = create<Record<string, { replace: boolean; seq: number } | undefined>>(() => ({}));

export const useGotoLine = create<{ open: boolean }>(() => ({ open: false }));

/** Paths of open file tabs, all panes in visual order, unique. */
export function openFilePaths(s: TabsState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of paneIds(s))
    for (const t of s.panes[id]?.tabs ?? [])
      if (t.input.kind === "file" && t.input.path && !seen.has(t.input.path)) {
        seen.add(t.input.path);
        out.push(t.input.path);
      }
  return out;
}

/** Editor Tabs › Sort tabs alphabetically: by file name. */
export function tabSortKey(input: EditorInput): string {
  return basename(input.path ?? input.key);
}

export function isTextTab(tab: Tab | null | undefined): tab is Tab & { input: { path: string } } {
  return !!tab && isTextInput(tab.input);
}

type EditorKinds = ReturnType<typeof useContributions.getState>["editorKinds"];

/** Tab title of an editor input: the file name, or what its editor kind calls it. */
export function tabTitle(input: EditorInput, kinds: EditorKinds): string {
  if (input.kind === "file") return basename(input.path ?? input.key);
  if (input.kind === "virtual")
    return (input.data as VirtualInputData | undefined)?.title ?? basename(input.path ?? input.key);
  const kind = kinds.get(input.kind);
  try {
    return kind?.title(input) ?? input.key;
  } catch {
    return input.key;
  }
}

export function tabIcon(input: EditorInput, kinds: EditorKinds): string {
  if (input.kind === "file") return fileIconName(basename(input.path ?? ""));
  if (input.kind === "virtual") return fileIconName(tabTitle(input, kinds));
  const kind = kinds.get(input.kind);
  try {
    return kind?.icon?.(input) ?? "file";
  } catch {
    return "file";
  }
}

export function sameStatus(a: EditorStatus, b: EditorStatus): boolean {
  return (
    a.path === b.path &&
    a.doc === b.doc &&
    a.offset === b.offset &&
    a.line === b.line &&
    a.col === b.col &&
    a.selectedChars === b.selectedChars &&
    a.selectedLines === b.selectedLines &&
    a.carets === b.carets
  );
}

/** Status bar caret / selection info derived from the slot's latest state. */
export function computeStatus(slot: EditorSlot): EditorStatus {
  const state = slot.currentState();
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  let chars = 0;
  let lines = 0;
  for (const r of state.selection.ranges) {
    chars += r.to - r.from;
    if (!r.empty) lines += state.doc.lineAt(r.to).number - state.doc.lineAt(r.from).number;
  }
  const status: EditorStatus = {
    path: slot.model.path,
    doc: slot.model.doc,
    line: line.number - 1,
    col: main.head - line.from,
    offset: main.head,
    selectedChars: chars,
    selectedLines: lines,
    carets: state.selection.ranges.length,
  };
  return status;
}
