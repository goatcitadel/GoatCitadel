import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { restoredTestExclude } from "../../vitest.shared";

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@goatcitadel/contracts/remote-worker-runtime-node": path.resolve(configDir, "../../packages/contracts/src/remote-worker-runtime-node.ts"),
      "@goatcitadel/contracts/mesh-schema-node": path.resolve(configDir, "../../packages/contracts/src/mesh-schema-node.ts"),
      "@goatcitadel/contracts": path.resolve(configDir, "../../packages/contracts/src/index.ts"),
    },
  },
  test: {
    exclude: restoredTestExclude,
  },
});
