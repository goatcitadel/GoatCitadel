import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolveLocalTestMaxWorkers, restoredTestExclude } from "../../vitest.shared";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@goatcitadel/session-control-client/http",
        replacement: fileURLToPath(new URL("../session-control-client/src/http-internal.ts", import.meta.url)),
      },
      {
        find: "@goatcitadel/session-control-client",
        replacement: fileURLToPath(new URL("../session-control-client/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    maxWorkers: resolveLocalTestMaxWorkers(),
    exclude: restoredTestExclude,
    setupFiles: ["./src/test/setup.ts"],
  },
});
