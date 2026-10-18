import { defineConfig } from "vitest/config";
import { resolveLocalTestMaxWorkers, restoredTestExclude } from "../../vitest.shared";

export default defineConfig({
  test: {
    maxWorkers: resolveLocalTestMaxWorkers(),
    exclude: restoredTestExclude,
    setupFiles: ["./src/test/setup.ts"],
  },
});
