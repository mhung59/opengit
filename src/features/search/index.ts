/**
 * Search & navigation: Search Everywhere (⇧⇧ and the Go to … choosers),
 * Recent Files / Recent Locations, Find / Replace in Files + the Find tool
 * window and file navigation.
 */
import { lazyComponent } from "@/ui";
import { activeEditor } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { EDIT_SCOPES_ACTION } from "@/platform/search";
import { provideFindResults, registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { installTracking, resetTracking } from "./common/tracking";
import { SearchEverywhereOverlay } from "./everywhere/SearchEverywhere";
import { hideSearchEverywhere, showSearchEverywhere } from "./everywhere/store";
import { FindInFilesOverlay } from "./find/FindInFiles";
import { ScopesDialogOverlay, showScopesDialog } from "./find/ScopesDialog";
import { hideFindPopup, parseFindArg, runFindPopupCommand, showFindPopup, useFindPopup } from "./find/store";
import { disposeFindWindow, openEditorResults, rerunActiveFindTab, useFindHeaderMenu } from "./find/windowStore";
import { RecentPopupsOverlay } from "./recent/RecentPopups";
import { cycleSwitcher, hideRecentPopup, showRecentPopup } from "./recent/store";
import { FileStructureOverlay, useFileStructurePopup } from "./structure/StructureView";
import { useOutline, useStructureOptions } from "./structure/store";

/** Single-line editor selection, used to prefill search fields. */
function editorSelectionText(): string | null {
  const view = activeEditor()?.view;
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to || to - from > 200) return null;
  const text = view.state.sliceDoc(from, to);
  return text.includes("\n") ? null : text;
}

type PopupKind = "everywhere" | "recent" | "find" | "fileStructure";

function closeAllPopups(except?: PopupKind) {
  if (except !== "everywhere") hideSearchEverywhere();
  if (except !== "recent") hideRecentPopup();
  if (except !== "find") hideFindPopup();
  if (except !== "fileStructure" && useFileStructurePopup.getState().open)
    useFileStructurePopup.setState({ open: false });
}

export function activate(): void | (() => void) {
  const se = (tab: Parameters<typeof showSearchEverywhere>[0]) => () => {
    closeAllPopups("everywhere");
    showSearchEverywhere(tab, { query: editorSelectionText() ?? undefined });
  };

  const disposers: Array<() => void> = [
    installTracking(),
    provideFindResults(openEditorResults),

    registerOverlay({ id: "search.everywhere", component: SearchEverywhereOverlay }),
    registerOverlay({ id: "search.recent", component: RecentPopupsOverlay }),
    registerOverlay({ id: "search.findInFiles", component: FindInFilesOverlay }),
    registerOverlay({ id: "search.scopes", component: ScopesDialogOverlay }),
    registerOverlay({ id: "search.fileStructure", component: FileStructureOverlay }),
    registerToolWindow({
      id: "find",
      title: "Find",
      icon: "toolwindow-find",
      anchor: "bottom",
      stripe: "onUse",
      order: 5,
      component: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindToolWindow)),
      headerContent: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindTabs)),
      headerActions: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindToolWindowActions)),
      headerMenu: useFindHeaderMenu,
    }),

    registerActions([
      {
        id: "navigate.searchEverywhere",
        title: "Search Everywhere",
        category: "Navigate",
        icon: "search",
        keywords: ["find", "goto", "everything"],
        run: se("all"),
      },
      {
        id: "navigate.gotoClass",
        title: "Go to Class…",
        category: "Navigate",
        keywords: ["type", "interface", "struct"],
        when: "projectOpen",
        run: se("classes"),
      },
      {
        id: "navigate.gotoFile",
        title: "Go to File…",
        category: "Navigate",
        icon: "file",
        keywords: ["open file"],
        when: "projectOpen",
        run: se("files"),
      },
      {
        id: "navigate.gotoSymbol",
        title: "Go to Symbol…",
        category: "Navigate",
        keywords: ["function", "method", "field"],
        when: "projectOpen",
        run: se("symbols"),
      },
      {
        id: "navigate.findAction",
        title: "Find Action…",
        category: "Help",
        keywords: ["command", "palette"],
        run: se("actions"),
      },
      {
        id: "navigate.searchText",
        title: "Search Text Everywhere",
        category: "Navigate",
        keywords: ["grep", "find text"],
        when: "projectOpen",
        run: se("text"),
      },
      {
        id: "navigate.recentFiles",
        title: "Recent Files",
        category: "Navigate",
        icon: "history",
        keywords: ["switcher"],
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          showRecentPopup("files");
        },
      },
      {
        id: "navigate.switcher",
        title: "Switcher",
        category: "Navigate",
        keywords: ["recent files", "tabs"],
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          cycleSwitcher(1);
        },
      },
      {
        id: "navigate.switcherBack",
        title: "Switcher (Backward)",
        category: "Navigate",
        hidden: true,
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          cycleSwitcher(-1);
        },
      },
      {
        id: "navigate.recentLocations",
        title: "Recent Locations",
        category: "Navigate",
        icon: "clock",
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          showRecentPopup("locations");
        },
      },
      {
        id: "find.inPath",
        title: "Find in Files…",
        category: "Find",
        icon: "search",
        keywords: ["grep", "search in path"],
        when: "projectOpen",
        run: ({ arg, ctx }) => {
          closeAllPopups("find");
          showFindPopup(false, { ...parseFindArg(arg, ctx), selection: editorSelectionText() });
        },
      },
      {
        // Rerun the selected search; ⌘R in the Find tool window, as in IDEA.
        id: "find.rerun",
        title: "Rerun Search",
        category: "Find",
        icon: "refresh",
        when: "projectOpen && activeToolWindow == 'find'",
        run: rerunActiveFindTab,
      },
      {
        id: EDIT_SCOPES_ACTION,
        title: "Edit Scopes…",
        category: "Find",
        keywords: ["custom scope", "file pattern"],
        when: "projectOpen",
        run: ({ arg }) => showScopesDialog(arg),
      },
      {
        id: "find.replaceInPath",
        title: "Replace in Files…",
        category: "Find",
        icon: "replace",
        when: "projectOpen",
        run: ({ arg, ctx }) => {
          closeAllPopups("find");
          showFindPopup(true, { ...parseFindArg(arg, ctx), selection: editorSelectionText() });
        },
      },
      // Keys of the Find in Files popup that are global shortcuts elsewhere (bound after them).
      ...(
        [
          ["find.popup.nextResult", "Next Result", "nextResult"],
          ["find.popup.previousResult", "Previous Result", "previousResult"],
          ["find.popup.openResult", "Open Result", "openResult"],
          ["find.popup.recentSearches", "Recent Searches", "recentSearches"],
        ] as const
      ).map(([id, title, command]) => ({
        id,
        title,
        category: "Find",
        hidden: true,
        when: "findPopupOpen",
        run: () => void runFindPopupCommand(command),
      })),
      {
        id: "navigate.fileStructure",
        title: "File Structure",
        category: "Navigate",
        icon: "structure",
        keywords: ["outline", "members"],
        run: () => {
          // Pressed again, IDEA toggles "Show inherited members" (when the server knows supertypes).
          if (useFileStructurePopup.getState().open) {
            if (useOutline.getState().inheritedSupported)
              useStructureOptions.setState((s) => ({ showInherited: !s.showInherited }));
            return;
          }
          closeAllPopups("fileStructure");
          useFileStructurePopup.setState({ open: true });
        },
      },
    ]),
  ];

  const onProject = (_root: string | null) => {
    closeAllPopups();
    disposeFindWindow();
  };
  onProject(useProject.getState().project?.root ?? null);
  disposers.push(
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      onProject(s.project?.root ?? null);
      resetTracking();
      // A directory scope pointed into the previous project.
      if (useFindPopup.getState().scopeTab === "directory")
        useFindPopup.setState({ scopeTab: "project", directory: "" });
    }),
  );

  return () => {
    closeAllPopups();
    disposeFindWindow();
    disposers.reverse().forEach((d) => d());
  };
}
