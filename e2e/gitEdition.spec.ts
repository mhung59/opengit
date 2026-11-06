import { expect, openFromTree, test } from "./fixtures";

test("retains the OpenIDEA workbench and Git tool windows", async ({ workbench: page }, testInfo) => {
  await openFromTree(page, "build.gradle.kts");
  const stripe = page.getByRole("toolbar", { name: "Tool windows", exact: true });
  for (const name of ["Project", "Commit", "Git", "Terminal"]) {
    await expect(stripe.getByRole("button", { name, exact: true })).toBeVisible();
  }
  for (const name of ["Bookmarks", "Notifications", "Problems", "Database", "Agents", "Services", "Structure"]) {
    await expect(stripe.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toHaveCount(0);
  await stripe.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
  await stripe.getByRole("button", { name: "Terminal", exact: true }).click();
  await stripe.getByRole("button", { name: "Git", exact: true }).click();
  await expect(page.getByRole("region", { name: "Git", exact: true })).toBeVisible();
  await stripe.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByRole("region", { name: "Commit", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Commit Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Commit Options", exact: true });
  await expect(options.getByRole("checkbox", { name: "Run Git hooks" })).toBeVisible();
  for (const name of ["Analyze code", "Reformat code", "Optimize imports", "Check TODO"]) {
    await expect(options.getByRole("checkbox", { name, exact: true })).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("original-git-workbench.png"), animations: "disabled" });
});

test("keeps the original Settings dialog without IDE service pages", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("treeitem", { name: "Keymap", exact: true })).toBeVisible();
  for (const name of [
    "Plugins",
    "Languages & Frameworks",
    "Build, Execution, Deployment",
    "Language Servers",
    "Agents",
    "Database",
    "Notifications",
    "Project Trust",
    "Security",
  ]) {
    await expect(dialog.getByRole("treeitem", { name, exact: true })).toHaveCount(0);
  }
});

test("opens a repository directly without a trust prompt or restricted banner", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const { openProject, useProject } = await import("/src/platform/project.ts");
    const { setInvokeRoute } = await import("/src/platform/tauriCore.ts");
    const project = useProject.getState().project!;
    // Browser tests stub the native open response; the real backend policy has
    // separate Rust integration coverage, including legacy restricted decisions.
    const invoked: string[] = [];
    setInvokeRoute((command) => {
      invoked.push(command);
      return command === "open_project" ? Promise.resolve(project) : null;
    });
    useProject.setState({ project: null, lightEdit: false });
    try {
      await openProject(project.root);
      if (invoked.some((command) => command.startsWith("project_trust_"))) {
        throw new Error("Opening a repository must not request IDE trust");
      }
    } finally {
      setInvokeRoute(null);
    }
  });
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Trust and Open Project?", exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Restricted Mode: project commands and tools are disabled.", { exact: true }),
  ).toHaveCount(0);
});

test("keeps the welcome layout with only repository and appearance entry points", async ({
  workbench: page,
}, testInfo) => {
  await page.evaluate(async () => {
    const { useProject } = await import("/src/platform/project.ts");
    useProject.setState({ project: null, lightEdit: false });
  });
  const welcome = page.getByRole("navigation", { name: "Welcome", exact: true });
  await expect(welcome.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
  await expect(welcome.getByRole("button", { name: "Customize", exact: true })).toBeVisible();
  await expect(welcome.getByRole("button", { name: "Plugins", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clone Repository", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Remote Development", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("original-welcome.png"), animations: "disabled" });
});
