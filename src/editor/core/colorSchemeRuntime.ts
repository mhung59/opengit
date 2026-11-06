/**
 * Applies Settings › Editor › Color Scheme (scheme + attribute overrides) as one
 * stylesheet, and Editor › Font › Typography Settings as the root's
 * `--fw-code` / `--fw-code-bold`.
 */
import { schemeCss } from "@/platform/colorScheme";
import { editorPrefs, fontWeightVars } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";

export function installColorScheme(): () => void {
  if (typeof document === "undefined") return () => {};
  const el = document.createElement("style");
  el.id = "openidea-editor-color-scheme";
  document.head.appendChild(el);
  const root = document.documentElement;
  const apply = () => {
    const settings = useProject.getState().settings;
    const prefs = editorPrefs(settings);
    const css = schemeCss(settings?.editor?.colorScheme, prefs.colorOverrides, undefined, prefs.customSchemes);
    if (el.textContent !== css) el.textContent = css;
    for (const [name, value] of Object.entries(fontWeightVars(prefs.fontWeight, prefs.boldFontWeight)))
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  };
  apply();
  const unsubscribe = useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings) apply();
  });
  const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(apply) : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-contrast", "data-color-theme"],
  });
  return () => {
    unsubscribe();
    observer?.disconnect();
    el.remove();
    root.style.removeProperty("--fw-code");
    root.style.removeProperty("--fw-code-bold");
  };
}
