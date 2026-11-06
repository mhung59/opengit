import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const boot = readFileSync("public/boot.js", "utf8");

function start(label = "main") {
  runInNewContext(boot, {
    document,
    localStorage,
    window: { __TAURI_INTERNALS__: { metadata: { currentWindow: { label } } } },
  });
}

afterEach(() => {
  localStorage.clear();
  for (const key of ["theme", "contrast", "colorTheme", "window"]) delete document.documentElement.dataset[key];
  document.getElementById("openidea-boot-colors")?.remove();
});

describe("startup theme", () => {
  it("restores the built-in palette and splash despite corrupt legacy plugin data", () => {
    localStorage.setItem("openidea.theme", JSON.stringify({ theme: "dark", colorTheme: "one-dark", frame: "#282c34" }));
    localStorage.setItem("openidea.pluginTheme", "invalid JSON");
    start();
    expect(document.documentElement.dataset).toMatchObject({ theme: "dark", colorTheme: "one-dark" });
    expect(document.getElementById("openidea-boot-colors")?.textContent).toContain("--boot-frame: #282c34");
    expect(document.getElementById("openidea-plugin-theme")).toBeNull();
  });

  it("still identifies Settings windows when saved theme data is corrupt", () => {
    localStorage.setItem("openidea.theme", "invalid JSON");
    start("settings-main");
    expect(document.documentElement.dataset.window).toBe("settings");
  });

  it("does not inject invalid palette names or splash colours", () => {
    localStorage.setItem("openidea.theme", JSON.stringify({ colorTheme: "dark;", frame: "red; color: blue" }));
    start();
    expect(document.documentElement.dataset.colorTheme).toBeUndefined();
    expect(document.getElementById("openidea-boot-colors")).toBeNull();
  });
});
