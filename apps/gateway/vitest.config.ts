import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { restoredTestExclude } from "../../vitest.shared";

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@goatcitadel/contracts",
        replacement: path.resolve(configDir, "../../packages/contracts/src/index.ts"),
      },
      {
        find: "@goatcitadel/skills",
        replacement: path.resolve(configDir, "../../packages/skills/src/index.ts"),
      },
      {
        find: "@goatcitadel/extensions-sdk",
        replacement: path.resolve(configDir, "../../packages/extensions-sdk/src/index.ts"),
      },
      {
        find: "@goatcitadel/gateway-core",
        replacement: path.resolve(configDir, "../../packages/gateway-core/src/index.ts"),
      },
      {
        find: "@goatcitadel/storage",
        replacement: path.resolve(configDir, "../../packages/storage/src/index.ts"),
      },
      {
        find: "@goatcitadel/mesh-core",
        replacement: path.resolve(configDir, "../../packages/mesh-core/src/index.ts"),
      },
      {
        find: "@goatcitadel/memory-core",
        replacement: path.resolve(configDir, "../../packages/memory-core/src/index.ts"),
      },
      {
        find: "@goatcitadel/orchestration",
        replacement: path.resolve(configDir, "../../packages/orchestration/src/index.ts"),
      },
      {
        find: "@goatcitadel/policy-engine",
        replacement: path.resolve(configDir, "../../packages/policy-engine/src/index.ts"),
      },
    ],
  },
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    exclude: [
      ...restoredTestExclude,
      "src/**/*.node.test.ts",
      "src/services/chat-generated-artifact-service.test.ts",
      "src/services/chat-thread-knowledge-service.test.ts",
    ],
  },
});
