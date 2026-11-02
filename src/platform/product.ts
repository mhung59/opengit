/** The Git edition retains the original workbench, editor and VCS UI. */
export function isProductAction(id: string, category?: string): boolean {
  if (
    category &&
    [
      "Code",
      "Refactor",
      "Analyze",
      "Run",
      "Build",
      "Debug",
      "Tools",
      "Database",
      "Plugins",
      "Agents",
      "Bookmarks",
    ].includes(category)
  )
    return false;
  if (
    /^(agents?|analysis|plugins|database|db|debug|run|build|coverage|profiler|bookmarks|tools|sdk|dependencies|deployment|deploy|remote|http|notebook|web|todo|scratch|libraries|macros|refactor)\./.test(
      id,
    )
  )
    return false;
  if (/bookmark/i.test(id)) return false;
  return !new Set([
    "view.notifications",
    "file.newProject",
    "file.invalidateCaches",
    "file.powerSaveMode",
    "file.togglePowerSave",
    "app.checkForUpdates",
    "navigate.gotoClass",
    "navigate.gotoSymbol",
    "navigate.fileStructure",
    "navigate.typeHierarchy",
    "navigate.callHierarchy",
    "navigate.gotoDefinition",
    "navigate.gotoImplementation",
    "navigate.findUsages",
    "editor.formatDocument",
    "editor.formatSelection",
    "editor.optimizeImports",
    "editor.codeCleanup",
    "ssh.startSession",
    "ssh.configurations",
  ]).has(id);
}
