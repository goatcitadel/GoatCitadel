import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1", ".ts.net"];
const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.resolve(configDir, "./package.json"), "utf8")) as {
  version?: string;
};

export function resolveViteAllowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.GOATCITADEL_VITE_ALLOWED_HOSTS?.trim();
  if (!raw) {
    return [...DEFAULT_ALLOWED_HOSTS];
  }
  const fromEnv = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = new Set<string>([...DEFAULT_ALLOWED_HOSTS, ...fromEnv]);
  return [...merged];
}

export default defineConfig(({ mode }) => {
  const env = {
    ...process.env,
    ...loadEnv(mode, repoRoot, ""),
  };
  const buildId = `${packageJson.version ?? "dev"}-${mode}`;

  return {
    envDir: repoRoot,
    define: {
      __GC_BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [tailwindcss(), react()],
    resolve: {
      // Fresh installer-based copies may not have workspace package dist output yet.
      // Resolve contracts from source so Mission Control stays bootable in dev mode.
      dedupe: ["react", "react-dom"],
      alias: [
        {
          find: "@",
          replacement: path.resolve(configDir, "./src"),
        },
        {
          find: "@goatcitadel/contracts",
          replacement: path.resolve(configDir, "../../packages/contracts/src/index.ts"),
        },
      ],
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      // Keep Tailnet/MagicDNS support while preserving explicit host checks.
      allowedHosts: resolveViteAllowedHosts(env),
      hmr: {
        // Prevent full-page reloads by keeping HMR connection stable.
        // overlay: false prevents the error overlay from triggering navigation.
        overlay: false,
      },
    },
    build: {
      // The remaining heavy payload is the Office/Herd HQ Three.js bundle, which is
      // lazily loaded and no longer part of the main application path.
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replaceAll("\\", "/");
            if (!normalized.includes("/node_modules/")) {
              return undefined;
            }

            if (normalized.includes("/node_modules/@react-three/fiber/")) {
              return "vendor-r3f";
            }
            if (normalized.includes("/node_modules/@react-three/drei/")) {
              return "vendor-drei";
            }
            if (normalized.includes("/node_modules/react-dom/") || normalized.includes("/node_modules/react/")) {
              return "vendor-react";
            }
            if (normalized.includes("/node_modules/@radix-ui/")) {
              return "vendor-radix";
            }
            if (normalized.includes("/node_modules/cmdk/")) {
              return "vendor-cmdk";
            }
            if (normalized.includes("/node_modules/react-virtuoso/")) {
              return "vendor-virtuoso";
            }
            if (normalized.includes("/node_modules/three-stdlib/")) {
              return "vendor-three-stdlib";
            }
            if (normalized.includes("/node_modules/three/build/")) {
              return "vendor-three-build";
            }
            return undefined;
          },
        },
      },
    },
    test: {
      setupFiles: "./src/test/setup.ts",
      testTimeout: 20000,
    },
  };
});
