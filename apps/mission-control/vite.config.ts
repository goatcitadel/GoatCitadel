import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1", ".ts.net"];
const MONACO_PUBLIC_BASE = "/vendor/monaco/vs";
const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.resolve(configDir, "./package.json"), "utf8")) as {
  version?: string;
};
type StreamableResponse = NodeJS.WritableStream & {
  destroyed?: boolean;
  headersSent?: boolean;
  statusCode?: number;
  destroy(error?: Error): void;
};

function getContentType(filePath: string): string {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function streamMonacoAsset(res: StreamableResponse, assetPath: string): void {
  void pipeline(fs.createReadStream(assetPath), res).catch((error) => {
    if (res.destroyed) {
      return;
    }
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
      return;
    }
    res.destroy(error instanceof Error ? error : undefined);
  });
}

function copyDirectory(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function resolveMonacoVsDirectory(packageRoot: string): string {
  const candidateDirectories = [
    path.resolve(packageRoot, "node_modules/monaco-editor/min/vs"),
    path.resolve(packageRoot, "../../node_modules/monaco-editor/min/vs"),
  ];
  for (const candidate of candidateDirectories) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve Monaco AMD assets for ${packageRoot}.`);
}

function sanitizeRelativeAssetPath(requestPath: string): string {
  return requestPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function monacoAmdAssetsPlugin(packageRoot: string): Plugin {
  const sourceDir = resolveMonacoVsDirectory(packageRoot);
  let viteConfig: ResolvedConfig | null = null;

  return {
    name: "goatcitadel-monaco-amd-assets",
    configResolved(config) {
      viteConfig = config;
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = req.url?.split("?")[0] ?? "";
        if (!requestUrl.startsWith(`${MONACO_PUBLIC_BASE}/`)) {
          next();
          return;
        }

        const relativeAssetPath = sanitizeRelativeAssetPath(requestUrl.slice(MONACO_PUBLIC_BASE.length));
        const resolvedAssetPath = path.resolve(sourceDir, `.${path.sep}${relativeAssetPath}`);
        if (
          !resolvedAssetPath.startsWith(sourceDir) ||
          !fs.existsSync(resolvedAssetPath) ||
          !fs.statSync(resolvedAssetPath).isFile()
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }

        res.setHeader("Content-Type", getContentType(resolvedAssetPath));
        streamMonacoAsset(res, resolvedAssetPath);
      });
    },
    writeBundle() {
      if (!viteConfig) {
        return;
      }
      const outputDir = path.resolve(viteConfig.root, viteConfig.build.outDir);
      const targetDir = path.join(outputDir, "vendor", "monaco", "vs");
      copyDirectory(sourceDir, targetDir);
    },
  };
}

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
    plugins: [monacoAmdAssetsPlugin(configDir), tailwindcss(), react()],
    resolve: {
      // Fresh installer-based copies may not have workspace package dist output yet.
      // Resolve contracts from source so Mission Control stays bootable in dev mode.
      dedupe: ["react", "react-dom"],
      alias: [
        {
          find: "@",
          replacement: path.resolve(configDir, "./src"),
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
