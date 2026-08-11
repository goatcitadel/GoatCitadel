import { defineConfig } from "vitest/config";
import { restoredTestExclude } from "../../vitest.shared";

export default defineConfig({
  test: {
    exclude: restoredTestExclude,
  },
});
