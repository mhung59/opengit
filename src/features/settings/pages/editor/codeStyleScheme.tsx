/**
 * Code Style › Scheme (IDEA's Default = IDE-level, Project = stored in the
 * project). The scheme is the scope shared by Code Style
 * and its language pages (`scopeGroup`); "Copy to Project" / "Copy to IDE"
 * stage every Code Style value in the other scope.
 */
import { useProject } from "@/platform/project";
import { Button, T, type SelectOption } from "@/ui";
import { Row, Select } from "../../components/Form";
import { usePageContext } from "../../components/context";
import { setPageScope, stage, stagedValue, useSettingsDialog, type Scope } from "../../model/staging";
import styles from "./CodeStyle.module.css";

export const CODE_STYLE_SCOPE = "editor.codeStyle";

/** What a Code Style scheme holds. */
export const CODE_STYLE_KEYS = [
  "editor.tabSize",
  "editor.insertSpaces",
  "editor.codeStyle.lineSeparator",
  "editor.codeStyle.hardWrapAt",
  "editor.codeStyle.visualGuides",
  "editor.codeStyle.detectIndents",
  "editor.codeStyle.editorconfig",
  "editor.codeStyle.languages",
  "editor.codeStyle.doNotFormat",
  "editor.codeStyle.formatterTagsEnabled",
  "editor.codeStyle.formatterOffTag",
  "editor.codeStyle.formatterOnTag",
  "editor.codeStyle.formatterTagsRegexp",
] as const;

/** Stages the `from` scheme's values in the `to` scheme (`page` owns the staged edits). */
export function copyScheme(page: string, from: Scope, to: Scope) {
  const s = useSettingsDialog.getState();
  for (const key of CODE_STYLE_KEYS) {
    const value = stagedValue(s, from, key);
    if (value !== undefined) stage(page, to, key, value);
  }
}

export function SchemeRow() {
  const { pageId, scope } = usePageContext();
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const canProject = hasProject && !newProjects;
  const options: SelectOption<Scope>[] = [
    { value: "global", label: "Default (IDE)" },
    ...(canProject ? [{ value: "project" as const, label: "Project" }] : []),
  ];
  const other: Scope = scope === "global" ? "project" : "global";
  return (
    <Row
      label="Scheme"
      hint={
        scope === "project" ? "Stored in the project." : "Stored in the IDE; used by projects without their own scheme."
      }
    >
      <span className={styles.scheme}>
        <Select<Scope>
          value={scope}
          options={options}
          onChange={(v) => setPageScope(CODE_STYLE_SCOPE, v)}
          aria-label="Scheme"
        />
        {canProject && (
          <Button
            size="small"
            onClick={() => {
              copyScheme(pageId, scope, other);
              setPageScope(CODE_STYLE_SCOPE, other);
            }}
          >
            <T>{scope === "global" ? "Copy to Project" : "Copy to IDE"}</T>
          </Button>
        )}
      </span>
    </Row>
  );
}
