/** Regenerate desktop icons and UI branding from the approved OpenGit master. */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const master = join(root, "assets/branding/opengit-logo-v2.png");
const staging = join(root, "artifacts.local/opengit-icons-v2");
const icons = join(root, "src-tauri/icons");
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [require.resolve("@tauri-apps/cli/tauri.js"), "icon", master, "-o", staging],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(icons, { recursive: true });
for (const entry of readdirSync(staging, { withFileTypes: true })) {
  // Mobile output is unnecessary for this desktop application.
  if (entry.isFile() && /\.(png|ico|icns)$/.test(entry.name)) {
    copyFileSync(join(staging, entry.name), join(icons, entry.name));
  }
}
copyFileSync(join(icons, "128x128@2x.png"), join(root, "public/opengit-logo.png"));
copyFileSync(join(icons, "32x32.png"), join(root, "public/favicon.png"));
