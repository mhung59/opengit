/**
 * Editor › Code Style (General, Other File Types, one page per language from
 * `languages/*.toml`) and Editor › File Encodings. Indentation feeds the
 * editor's effective indent (EditorConfig › detected › language override ›
 * language definition › Other File Types); line separator and encodings feed
 * new-file creation in the backend (`ide-workspace::FileDefaults`). The
 * Scheme (Default / Project) is the scope these pages share; the Formatter tab
 * feeds `platform/formatGuard`.
 */
import { lineCommentDefaults, type LanguageCodeStyle } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import { commands, isTauri, type LanguageInfo_Serialize as LanguageInfo } from "@/platform/ipc";
import { Button, Checkbox, Input, T, type SelectOption } from "@/ui";
import { useId } from "react";
import { NumberInput, Row, Select } from "../../components/Form";
import { useSetting } from "../../components/context";
import type { PageSpec } from "../spec";
import styles from "./Editor.module.css";
import { CODE_STYLE_SCOPE, SchemeRow } from "./codeStyleScheme";

/** Shared by Code Style and its sub-pages: the scheme is one scope. */
const SCHEME_SCOPE = { projectScope: true, scopeGroup: CODE_STYLE_SCOPE, ownScopeSwitch: true } as const;

/** Tabs and Indents of one language: overrides on top of the language definition. */
function LanguageStyle({ lang }: { lang: LanguageInfo }) {
  const [all, setAll] = useSetting<Record<string, LanguageCodeStyle>>("editor.codeStyle.languages");
  const [tabSize] = useSetting<number>("editor.tabSize");
  const [spaces] = useSetting<boolean>("editor.insertSpaces");
  const [wrap] = useSetting<number>("editor.codeStyle.hardWrapAt");
  const own = all?.[lang.id] ?? {};
  const base = { useTab: !(lang.indent?.insertSpaces ?? spaces), tabSize: lang.indent?.tabSize ?? tabSize };
  const eff = {
    useTab: own.useTab ?? base.useTab,
    tabSize: own.tabSize ?? base.tabSize,
    indent: own.indent ?? own.tabSize ?? base.tabSize,
    hardWrapAt: own.hardWrapAt ?? wrap,
    lineCommentAtFirstColumn: own.lineCommentAtFirstColumn ?? lineCommentDefaults(lang.id).atFirstColumn,
    lineCommentAddSpace: own.lineCommentAddSpace ?? lineCommentDefaults(lang.id).addSpace,
  };
  const set = (patch: Partial<LanguageCodeStyle>) => {
    const next = { ...own, ...patch };
    setAll({ ...(all ?? {}), [lang.id]: next });
  };
  const reset = () => {
    const next = { ...(all ?? {}) };
    delete next[lang.id];
    setAll(next);
  };
  return (
    <div className={styles.page}>
      <SchemeRow />
      {lang.id === "java" && <JavaFormatter style={own} onChange={set} />}
      <section aria-label={tx("Tabs and Indents")}>
        <div className={styles.previewTitle}>
          <T>Tabs and Indents</T>
        </div>
        <div className={styles.check}>
          <Checkbox checked={eff.useTab} onChange={(v) => set({ useTab: v })} label="Use tab character" />
        </div>
        <Row label="Tab size">
          <NumberInput
            value={eff.tabSize}
            onChange={(n) => set({ tabSize: n })}
            min={1}
            max={16}
            integer
            aria-label="Tab size"
          />
        </Row>
        <Row label="Indent">
          <NumberInput
            value={eff.indent}
            onChange={(n) => set({ indent: n })}
            min={1}
            max={16}
            integer
            aria-label="Indent"
          />
        </Row>
      </section>
      <section aria-label={tx("Wrapping")}>
        <div className={styles.previewTitle}>
          <T>Wrapping</T>
        </div>
        <Row label="Hard wrap at" hint="Shown as the right margin guide in the editor.">
          <NumberInput
            value={eff.hardWrapAt}
            onChange={(n) => set({ hardWrapAt: n })}
            min={1}
            max={999}
            integer
            aria-label="Hard wrap at"
            unit="columns"
          />
        </Row>
      </section>
      {lang.lineComment && (
        <section aria-label={tx("Comment Code")}>
          <div className={styles.previewTitle}>
            <T>Comment Code</T>
          </div>
          <div className={styles.check}>
            <Checkbox
              checked={eff.lineCommentAtFirstColumn}
              onChange={(v) => set({ lineCommentAtFirstColumn: v })}
              label="Line comment at first column"
            />
          </div>
          <div className={styles.check}>
            <Checkbox
              checked={eff.lineCommentAddSpace}
              onChange={(v) => set({ lineCommentAddSpace: v })}
              label="Add a space at line comment start"
            />
          </div>
        </section>
      )}
      <div className={styles.schemeRow}>
        <Button size="small" disabled={!all?.[lang.id]} onClick={reset}>
          <T>Reset to Language Defaults</T>
        </Button>
        <span className={styles.inherited}>
          {base.useTab
            ? tx`Defaults from the ${lang.name} language definition: tab.`
            : tx`Defaults from the ${lang.name} language definition: ${base.tabSize} spaces.`}
        </span>
      </div>
    </div>
  );
}

const JAVA_FORMATTERS: SelectOption<NonNullable<LanguageCodeStyle["formatter"]>>[] = [
  { value: "default", label: "Default" },
  { value: "intellij", label: "IntelliJ IDEA" },
  { value: "custom", label: "Custom Eclipse formatter XML" },
];

function JavaFormatter({
  style,
  onChange,
}: {
  style: LanguageCodeStyle;
  onChange: (patch: Partial<LanguageCodeStyle>) => void;
}) {
  const id = useId();
  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      title: tx("Eclipse formatter XML"),
      filters: [{ name: "XML", extensions: ["xml"] }],
    });
    if (typeof path === "string") onChange({ formatterPath: path });
  };
  return (
    <section aria-label={tx("Formatting profile")}>
      <Row
        label="Formatting profile"
        hint="Changes take effect after Apply without restarting the Java language server."
      >
        <Select
          value={style.formatter ?? "default"}
          options={JAVA_FORMATTERS}
          onChange={(formatter) => onChange({ formatter })}
          aria-label="Formatting profile"
        />
      </Row>
      {style.formatter === "custom" && (
        <Row
          label="Eclipse formatter XML"
          htmlFor={id}
          hint="Absolute or project-relative path. To reload an edited XML file, switch to Default, apply, then select Custom again."
        >
          <Input
            id={id}
            value={style.formatterPath ?? ""}
            onChange={(e) => onChange({ formatterPath: e.target.value })}
          />
          <Button size="small" onClick={browse}>
            <T>Browse…</T>
          </Button>
        </Row>
      )}
    </section>
  );
}

const SKIP = new Set(["plaintext", "log", "diff", "ignore", "gitattributes"]);

/** One Code Style page per language (registered once the language list is known). */
export async function codeStyleLanguagePages(): Promise<PageSpec[]> {
  if (!isTauri()) return [];
  const langs = await commands.languages();
  return langs
    .filter((l) => !SKIP.has(l.id))
    .map((lang) => ({
      id: `editor.codeStyle.${lang.id}`,
      title: lang.name,
      group: "Editor",
      order: 100,
      ...SCHEME_SCOPE,
      keywords: [
        "Scheme",
        "Tabs and Indents",
        "Tab size",
        "Indent",
        "Use tab character",
        "Hard wrap at",
        "Comment Code",
        "Line comment at first column",
        ...(lang.id === "java"
          ? ["Formatting profile", "IntelliJ IDEA", "Custom Eclipse formatter XML", "Eclipse formatter XML"]
          : []),
      ],
      component: () => <LanguageStyle lang={lang} />,
    }));
}
