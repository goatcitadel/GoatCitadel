/**
 * Vitest 4 trimmed the built-in `exclude` list down to `node_modules` and `.git`
 * only — vitest 3 also excluded `dist`, `coverage`, `build`, and editor/cache
 * folders. Without restoring those, the compiled test files that `tsc -b` emits
 * under `dist` get collected and run a second time alongside their `src` sources
 * (and a stale `dist` copy fails the run). Re-add the build-output exclusions so
 * every package keeps the vitest 3 collection behavior.
 *
 * Kept dependency-free (no `vitest/config` import) so it can be pulled into a
 * `vite.config.ts` `test` block without dragging vitest into `vite build`.
 */
export const restoredTestExclude: string[] = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/coverage/**",
  "**/build/**",
  "**/.{idea,cache,output,temp}/**",
];
