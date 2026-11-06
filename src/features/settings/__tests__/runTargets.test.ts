import { describe, expect, it } from "vitest";
import { pageLabels } from "../pages/registry";
import { parentPath } from "../pages/runTargets";

describe("Run Targets page", () => {
  it("does not contribute fields to Git edition settings search", () => {
    expect(pageLabels("build.runTargets")).toEqual([]);
  });

  it("walks up remote folders", () => {
    expect(parentPath("/home/me/app")).toBe("/home/me");
    expect(parentPath("/home/")).toBe("/");
    expect(parentPath("~/app")).toBe("~");
    expect(parentPath("~")).toBeNull();
    expect(parentPath("/")).toBeNull();
  });
});
