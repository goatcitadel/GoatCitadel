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

/**
 * Vitest's default pool size is (cores - 1) fork workers per run — 23 on a
 * 24-core dev box. Several agent sessions testing at once then exhaust RAM and
 * page the whole machine into 30-second freezes. Cap workers on local runs; CI
 * keeps vitest's default. `GOATCITADEL_TEST_MAX_WORKERS` overrides the cap, and a
 * CLI `--maxWorkers` still wins over both.
 */
export const LOCAL_TEST_MAX_WORKERS_DEFAULT = 2;

export function resolveLocalTestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const override = Number.parseInt(env.GOATCITADEL_TEST_MAX_WORKERS ?? "", 10);
  if (Number.isInteger(override) && override > 0) {
    return override;
  }
  return env.CI ? undefined : LOCAL_TEST_MAX_WORKERS_DEFAULT;
}
