import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

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
    ],
  },
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    exclude: [
      ...configDefaults.exclude,
      "src/**/*.node.test.ts",
      "src/services/chat-generated-artifact-service.test.ts",
      "src/services/chat-thread-knowledge-service.test.ts",
    ],
  },
});
