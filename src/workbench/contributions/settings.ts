/** Settings page registry, staged forms and search index. */
import { createContext, useContext, type ComponentType } from "react";
import { create } from "zustand";

// ---------------------------------------------------------------------------
// Settings pages, shown in the Settings dialog (⌘,) tree. Features contribute
// their own pages (e.g. Languages & Servers, Plugins); the settings feature
// renders the tree, search and the page host.

export interface SettingsPageContribution {
  /** Dotted path defines nesting, e.g. `languages.servers`. */
  id: string;
  title: string;
  /** Parent group title for top-level grouping, e.g. "Editor", "Tools". */
  group?: string;
  order?: number;
  /** Extra words matched by the settings search. */
  keywords?: string[];
  /** Omitted: the page lists links to its sub-pages. */
  component?: ComponentType;
  /** The page edits settings that a project can override (Global / This project switch). */
  projectScope?: boolean;
}

/**
 * What a settings page edits through: values of the page's scope with the
 * edits not applied yet. Edits are written on Apply / OK and dropped on Cancel.
 */
export interface SettingsForm {
  scope: "global" | "project";
  /** Value of a dotted key (map entries too, e.g. `languageServers.ruff.args`). */
  useValue(key: string): unknown;
  /** Stages a value; `null` removes the key on Apply. */
  set(key: string, value: unknown): void;
}

export const SettingsFormContext = createContext<SettingsForm | null>(null);

/** The form of the settings page being shown (provided by the Settings dialog). */
export function useSettingsForm(): SettingsForm {
  const form = useContext(SettingsFormContext);
  if (!form) throw new Error("useSettingsForm outside a settings page");
  return form;
}

export const useSettingsPages = create<{ pages: Map<string, SettingsPageContribution> }>(() => ({ pages: new Map() }));

export function registerSettingsPage(page: SettingsPageContribution): () => void {
  useSettingsPages.setState((s) => ({ pages: new Map(s.pages).set(page.id, page) }));
  return () =>
    useSettingsPages.setState((s) => {
      if (s.pages.get(page.id) !== page) return s;
      const pages = new Map(s.pages);
      pages.delete(page.id);
      return { pages };
    });
}

/** A searchable settings entry: a page, or an option label on it (Search Everywhere's "Settings: …" items). */
export interface SettingsSearchEntry {
  pageId: string;
  /** Page title or option label. */
  title: string;
  /** Breadcrumb of the page ("Editor", "General"). */
  path: string[];
  /** Extra words that match this entry (page keywords). */
  keywords?: string[];
}

let settingsSearchIndex: (() => Promise<SettingsSearchEntry[]>) | null = null;

/** The settings feature provides its search index (pages load lazily, so it is async). */
export function provideSettingsSearchIndex(index: () => Promise<SettingsSearchEntry[]>): () => void {
  settingsSearchIndex = index;
  return () => {
    if (settingsSearchIndex === index) settingsSearchIndex = null;
  };
}

export function searchableSettings(): Promise<SettingsSearchEntry[]> {
  return settingsSearchIndex ? settingsSearchIndex() : Promise.resolve([]);
}
