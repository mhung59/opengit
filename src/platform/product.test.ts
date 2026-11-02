import { describe, expect, it } from "vitest";
import { isProductAction } from "./product";

describe("Git edition action surface", () => {
  it("retains Git, file editing and the original shell controls", () => {
    for (const id of [
      "vcs.commit",
      "vcs.push",
      "vcs.showLog",
      "editor.save",
      "file.openProject",
      "file.settings",
      "navigate.gotoFile",
      "navigate.searchEverywhere",
      "window.close",
      "terminal.new",
      "terminal.openAt",
    ]) {
      expect(isProductAction(id)).toBe(true);
    }
  });
  it("removes IDE-only actions even when contributed through a shared component", () => {
    for (const id of [
      "agent.create",
      "plugins.installFromDisk",
      "database.open",
      "remote.connect",
      "bookmarks.newList",
      "navigate.toggleBookmark",
      "navigate.gotoBookmark1",
      "view.notifications",
      "run.start",
      "debug.start",
      "analysis.inspect",
      "navigate.gotoClass",
      "navigate.gotoSymbol",
      "editor.formatDocument",
    ]) {
      expect(isProductAction(id)).toBe(false);
    }
    expect(isProductAction("editor.anyCodeAction", "Code")).toBe(false);
  });
});
