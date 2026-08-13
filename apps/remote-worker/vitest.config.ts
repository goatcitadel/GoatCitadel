import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { restoredTestExclude } from "../../vitest.shared";

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@goatcitadel/contracts": path.resolve(configDir, "../../packages/contracts/src/index.ts"),
    },
  },
  test: {
    exclude: restoredTestExclude,
  },
});
