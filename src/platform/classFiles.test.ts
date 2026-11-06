import { describe, expect, it } from "vitest";
import { classFileBreakpointReason, isClassFile } from "./classFiles";
import { isVirtualUri } from "./virtualDocs";

describe("compiled class routing", () => {
  it.each([
    "/p/target/classes/p/C.class",
    "/p/build/classes/java/main/p/C$1.class",
    "C:\\p\\out\\C.class",
    "file:///p/out/C.class",
  ])("recognizes compiled output: %s", (path) => {
    expect(isClassFile(path)).toBe(true);
    expect(classFileBreakpointReason(path)).toBeTruthy();
  });
  it.each([
    "jdt://contents/a.jar/p/C.class?=p/a.jar%3Cp%28C.class",
    "jdt://contents/a.jar/p/C.java?=p/a.jar%3Cp%28C.class",
    "/p/src/main/java/p/C.java",
  ])("does not treat source and JDT documents as disk class files: %s", (path) => {
    expect(isClassFile(path)).toBe(false);
    expect(classFileBreakpointReason(path)).toBeNull();
  });
  it("treats disk class URIs as read-only server documents", () => {
    expect(isVirtualUri("file:///p/out/C.class")).toBe(true);
    expect(isVirtualUri("file:///p/src/C.java")).toBe(false);
    expect(isClassFile("/m2/a.jar!/p/C.class")).toBe(true);
  });
});
