import type { FileMatches, SearchQuery } from "@/platform/ipc";
import { describe, expect, it, vi } from "vitest";
import { SeController, type SeDeps, type SeSnapshot } from "../everywhere/controller";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides: Partial<SeDeps> = {}) {
  let id = 0;
  const deps: SeDeps = {
    findFiles: vi.fn(async () => []),
    findSymbols: vi.fn(async () => []),
    searchText: vi.fn(async () => {}),
    cancel: vi.fn(),
    nextRequestId: () => ++id,
    actions: () => [],
    isEnabled: () => true,
    recentFiles: async () => [],
    recentActions: () => [],
    root: () => "/p",
    now: () => 0,
    ...overrides,
  };
  const snaps: SeSnapshot[] = [];
  const c = new SeController(deps, (s) => snaps.push(s));
  return { c, deps, snaps, last: () => snaps[snaps.length - 1]! };
}

const fm = (rel: string) => ({ path: `/p/${rel}`, relPath: rel, score: 1, indices: [] });

describe("SeController", () => {
  it("streams each section independently", async () => {
    const files = deferred<ReturnType<typeof fm>[]>();
    const { c, last } = setup({
      findFiles: () => files.promise,
      actions: () => [{ id: "x", title: "Order Things", run: () => {} }],
    });
    c.run({ query: "ord", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    // Actions answered synchronously; files are still pending.
    expect(last().sections.get("actions")!.items).toHaveLength(1);
    expect(last().sections.get("files")!.loading).toBe(true);
    expect(last().loading).toBe(true);
    files.resolve([fm("Order.kt")]);
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/Order.kt"]);
  });

  it("drops late results of a superseded query and cancels its requests", async () => {
    const first = deferred<ReturnType<typeof fm>[]>();
    const findFiles = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([fm("New.kt")]);
    const lsp = deferred<never[]>();
    const { c, deps, last } = setup({ findFiles, workspaceSymbols: () => lsp.promise });
    c.run({ query: "old", tab: "files", includeNonProject: false, extra: {} });
    c.run({ query: "new", tab: "files", includeNonProject: false, extra: {} });
    first.resolve([fm("Old.kt")]);
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/New.kt"]);

    c.run({ query: "sym", tab: "text", includeNonProject: false, extra: {} });
    c.run({ query: "sym2", tab: "text", includeNonProject: false, extra: {} });
    expect(deps.cancel).toHaveBeenCalled();
  });

  it("parses File.kt:42 and opens files at the line", async () => {
    const findFiles = vi.fn(async () => [fm("File.kt")]);
    const { c, last } = setup({ findFiles });
    c.run({ query: "File.kt:42:3", tab: "files", includeNonProject: false, extra: {} });
    await flush();
    expect(findFiles).toHaveBeenCalledWith("File.kt", 51);
    const item = last().sections.get("files")!.items[0]!;
    expect(item.kind === "file" && [item.line, item.col]).toEqual([41, 2]);
  });

  it("shows recent files for an empty query", async () => {
    const { c, last } = setup({ recentFiles: async () => ["/p/a/B.kt", "/p/C.kt"] });
    c.run({ query: "", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    expect(
      last()
        .sections.get("recent")!
        .items.map((i) => (i.kind === "file" ? i.rel : "")),
    ).toEqual(["a/B.kt", "C.kt"]);
  });

  it("re-fetches only the section whose limit changed (Show more)", async () => {
    const findFiles = vi.fn(async () => [fm("A.kt")]);
    const findSymbols = vi.fn(async () => []);
    const { c } = setup({ findFiles, findSymbols });
    c.run({ query: "a", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    c.run({ query: "a", tab: "all", includeNonProject: false, extra: { files: 15 } });
    await flush();
    expect(findFiles).toHaveBeenCalledTimes(2);
    expect(findFiles).toHaveBeenLastCalledWith("a", 22);
    expect(findSymbols).not.toHaveBeenCalled();
  });
  it("does not query index or language-server symbols in the Git edition", async () => {
    const findSymbols = vi.fn(async () => []);
    const workspaceSymbols = vi.fn(async () => []);
    const { c, last } = setup({ findSymbols, workspaceSymbols });
    c.run({ query: "ord", tab: "symbols", includeNonProject: false, extra: {} });
    await flush();
    expect(last().sections.has("symbols")).toBe(false);
    expect(findSymbols).not.toHaveBeenCalled();
    expect(workspaceSymbols).not.toHaveBeenCalled();
  });

  it("streams text matches up to the limit", async () => {
    const searchText = vi.fn(async (_id: number, q: SearchQuery, onFile: (f: FileMatches) => void) => {
      expect(q.maxMatches).toBe(7);
      for (let i = 0; i < 3; i++)
        onFile({
          path: `/p/${i}.kt`,
          relPath: `${i}.kt`,
          matches: [1, 2, 3].map((line) => ({ line, text: "order", ranges: [[0, 5]], textOffset: 0 })),
        });
    });
    const { c, last } = setup({ searchText });
    c.run({ query: "order", tab: "all", includeNonProject: false, extra: {} });
    await flush();
    const text = last().sections.get("text")!;
    expect(text.items).toHaveLength(6);
    expect(text.hasMore).toBe(true);
    expect(text.loading).toBe(false);
  });

  it("narrows Files / Symbols / Text to Project Production or Test Files", async () => {
    const isTest = (path: string) => path.includes("/test/");
    const findFiles = vi.fn(async () => [fm("src/main/A.kt"), fm("src/test/ATest.kt")]);
    const searchText = vi.fn(async (_r: number, _q: SearchQuery) => {});
    const { c, last } = setup({
      findFiles,
      searchText,
      inFileSet: (set, path) => (set === "all" ? true : isTest(path) === (set === "test")),
    });
    c.run({ query: "a", tab: "files", includeNonProject: false, fileSet: "test", extra: {} });
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/src/test/ATest.kt"]);
    expect(findFiles).toHaveBeenLastCalledWith("a", 4 * 50 + 1);
    c.run({ query: "a", tab: "files", includeNonProject: false, fileSet: "production", extra: {} });
    await flush();
    expect(
      last()
        .sections.get("files")!
        .items.map((i) => i.key),
    ).toEqual(["f:/p/src/main/A.kt"]);
    // "All Places" ignores the narrowed scope.
    c.run({ query: "a", tab: "files", includeNonProject: true, fileSet: "production", extra: {} });
    await flush();
    expect(last().sections.get("files")!.items).toHaveLength(2);
    c.run({ query: "needle", tab: "text", includeNonProject: false, fileSet: "test", extra: {} });
    await flush();
    expect(searchText.mock.calls.at(-1)![1].scope).toEqual({ kind: "fileSet", set: "test" });
  });
});
