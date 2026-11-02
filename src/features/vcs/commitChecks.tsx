/** Git-only checks. Code analysis and language-server modifications are not part of this application. */
import type { ReactNode } from "react";
import { call, commands, isTauri } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { baseName, effectiveKind, relTo, stripSlash } from "./model";
import { currentRepo, useVcs } from "./store";
import { tx } from "@/platform/i18n";

// Problems

/**
 * A failed before-commit check, shown in the commit panel (as IDEA)
 * while the Commit button turns into "Commit Anyway".
 */
export interface CommitProblem {
  title: string;
  text: ReactNode;
  /** "Review" / "Show details" link. */
  details?: { label: string; run: () => void };
}

// ---------------------------------------------------------------------------
// Git: names invalid on Windows, large files

const WINDOWS_RESERVED = new Set(
  ["CON", "PRN", "AUX", "NUL"].concat([1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`])),
);
// eslint-disable-next-line no-control-regex
const WINDOWS_INVALID = /[<>:"\\|?*\u0000-\u001f]/;

/** The first path segment below `root` that Windows rejects (IDEA's GitFileNameCheckinHandler). */
export function badFileName(
  paths: readonly string[],
  root: string,
): { name: string; kind: "reserved" | "char" } | null {
  for (const p of paths) {
    for (const name of relTo(root, p).split("/")) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      if (WINDOWS_RESERVED.has(stem.toUpperCase())) return { name, kind: "reserved" };
      if (WINDOWS_INVALID.test(name)) return { name, kind: "char" };
    }
  }
  return null;
}

/** Files bigger than `limit` bytes; sizes come from listing their folders. */
async function largeFiles(paths: readonly string[], limit: number): Promise<Array<{ path: string; size: number }>> {
  const byDir = new Map<string, Set<string>>();
  for (const p of paths) {
    const dir = p.slice(0, p.lastIndexOf("/")) || "/";
    (byDir.get(dir) ?? byDir.set(dir, new Set()).get(dir)!).add(p);
  }
  const out: Array<{ path: string; size: number }> = [];
  for (const [dir, wanted] of byDir) {
    try {
      for (const e of await call(commands.fsReadDir(dir)))
        if (wanted.has(e.path) && e.kind === "file" && e.size > limit) out.push({ path: e.path, size: e.size });
    } catch {
      // unreadable folder
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export interface CommitCandidate {
  /** Absolute path. */
  path: string;
  /** False for deletions. */
  exists: boolean;
}

/**
 * Runs the configured before-commit modifications and checks for the files about to
 * be committed. Resolves the problems found; the commit goes ahead only without any.
 */
export async function runCommitChecks(files: readonly CommitCandidate[], _amend: boolean): Promise<CommitProblem[]> {
  const { git } = workflowSettings().vcs;
  const branch = useVcs.getState().branch;
  const problems: CommitProblem[] = [];

  if (git.warnDetachedHead && branch && (!branch.head || branch.operation === "rebase")) {
    const rebase = branch.operation === "rebase";
    problems.push({
      title: rebase ? "Commit during rebase" : "Commit in detached HEAD",
      text: rebase
        ? "A rebase is in progress. The commit will become part of the rebased history; usually you continue the rebase instead."
        : "HEAD is detached: the commit won't belong to any branch and may be lost after checking out another branch. Create a branch first to keep it.",
    });
  }

  const existing = files.filter((f) => f.exists).map((f) => f.path);
  if (git.warnBadFileNames) {
    // New paths only: a name already in the repository is not this commit's problem.
    const kinds = new Map(useVcs.getState().status.map((f) => [stripSlash(f.path), effectiveKind(f)]));
    const added = existing.filter((p) => ["added", "untracked", "renamed"].includes(kinds.get(p) ?? ""));
    const bad = badFileName(added, useVcs.getState().root ?? "");
    if (bad)
      problems.push({
        title: "File names",
        text:
          bad.kind === "reserved"
            ? tx`Some files use reserved names that are not allowed on Windows: '${bad.name}'. If you commit, it will not be possible to check out the Git repository on Windows.`
            : tx`Some of the file names contain characters that are not allowed on Windows: '${bad.name}'. If you commit, it might not be possible to check out the Git repository on Windows.`,
      });
  }
  if (!isTauri() || !existing.length) return problems;

  if (git.warnLargeFiles) {
    const large = await largeFiles(existing, git.largeFileMb * 1024 * 1024);
    if (large.length) {
      const mb = Math.ceil(large.reduce((n, f) => n + f.size, 0) / (1024 * 1024));
      problems.push({
        title: "Large files",
        text:
          large.length === 1
            ? tx`You are about to commit a large file into the repository: ${baseName(large[0]!.path)} (${mb} MB). It is not recommended to store large files in a Git repository. Consider using Git LFS.`
            : tx`You are about to commit ${large.length} large files into the repository with the total size of ${mb} MB. It is not recommended to store large files in a Git repository. Consider using Git LFS.`,
      });
    }
  }

  if (git.warnCrlf) {
    const autocrlf = (
      await call(commands.vcsConfigGet(currentRepo(), "core.autocrlf")).catch(() => null)
    )?.toLowerCase();
    if (autocrlf !== "true" && autocrlf !== "input") {
      const crlf: string[] = [];
      for (const p of existing) {
        try {
          if ((await call(commands.fsReadText(p))).includes("\r\n")) crlf.push(p);
        } catch {
          // skip
        }
      }
      if (crlf.length) {
        const crlfNames = crlf.slice(0, 5).map(baseName).join(", ") + (crlf.length > 5 ? ", …" : "");
        problems.push({
          title: "Line separators",
          text: (
            <>
              {crlf.length === 1
                ? tx`${crlf.length} file (${crlfNames}) contain CRLF line separators and core.autocrlf is not set, so they would be committed with CRLF. Convert them with the line separator widget in the status bar, or set`
                : tx`${crlf.length} files (${crlfNames}) contain CRLF line separators and core.autocrlf is not set, so they would be committed with CRLF. Convert them with the line separator widget in the status bar, or set`}{" "}
              <code>git config core.autocrlf input</code>.
            </>
          ),
        });
      }
    }
  }
  return problems;
}
