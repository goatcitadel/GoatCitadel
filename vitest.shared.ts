import { configDefaults } from "vitest/config";

/**
 * Vitest 4 trimmed the built-in `exclude` list down to `node_modules` and `.git`
 * only — vitest 3 also excluded `dist`, `coverage`, `build`, and editor/cache
 * folders. Without restoring those, the compiled test files that `tsc -b` emits
 * under `dist` get collected and run a second time alongside their `src` sources
 * (and a stale `dist` copy fails the run). Re-add the build-output exclusions so
 * every package keeps the vitest 3 collection behavior.
 */
export const restoredTestExclude: string[] = [
  ...configDefaults.exclude,
  "**/dist/**",
  "**/coverage/**",
  "**/build/**",
  "**/.{idea,cache,output,temp}/**",
];
