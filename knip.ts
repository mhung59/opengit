import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // Keep the production root explicit: plugin-discovered test entries must not
  // replace the application graph when running `knip --production`.
  entry: ["src/main.tsx!"],
  project: [
    "src/**/*.{ts,tsx,css}!",
    "!src/**/*.test.{ts,tsx}!",
    "!src/editor/core/cm/angular/parser.terms.ts",
    "scripts/**/*.ts",
    "perf/**/*.ts",
    "e2e/**/*.ts",
  ],
  ignoreExportsUsedInFile: true,
  // lint-staged formats Rust files with the toolchain's rustfmt.
  ignoreBinaries: ["rustfmt"],
  // Browser-side imports are served by Vite from the repository root.
  ignoreUnresolved: ["/src/platform/project.ts", "/src/platform/tauriCore.ts"],
  compilers: {
    // Fonts come in through `@import` in global.css.
    css: (text: string) => [...text.matchAll(/(?<=@)import[^;]+/g)].join("\n"),
  },
};

export default config;
