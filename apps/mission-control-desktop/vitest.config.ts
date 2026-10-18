import { defineConfig } from "vitest/config";
import { resolveLocalTestMaxWorkers, restoredTestExclude } from "../../vitest.shared";

// vite.config.ts only carries dev-server and build options, so tests lose nothing
// when vitest prefers this file over it.
export default defineConfig({
  test: {
    maxWorkers: resolveLocalTestMaxWorkers(),
    exclude: restoredTestExclude,
  },
});
