/**
 * Build, Execution, Deployment › Run Targets: SSH hosts run configurations can
 * run on (`RunConfig.target`). Consumed by `ide-run` and the run feature.
 */

/** Parent of a remote path (`~/a` → `~`, `/a` → `/`); null at the top. */
export function parentPath(path: string): string | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === "/" || p === "~" || p === "") return null;
  const i = p.lastIndexOf("/");
  if (i < 0) return null;
  return i === 0 ? "/" : p.slice(0, i);
}
