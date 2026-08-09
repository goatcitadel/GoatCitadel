import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-node/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.tmp/**",
      "**/.codex-tmp/**",
      "**/.codex-smoke/**",
      "**/.claude/**",
      "**/.worktrees/**",
      "**/.scratch/**",
      "**/.ds-sync/**",
      "ds-bundle/**",
      ".design-sync/.cache/**",
      ".design-sync/learnings/**",
      ".design-sync/node_modules/**",
      "reports/**",
      "workspace/goatcitadel_out/**",
      "**/src-tauri/target/**",
      "**/artifacts/**",
      "vendor/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Blob: "readonly",
        Buffer: "readonly",
        EventSource: "readonly",
        File: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        atob: "readonly",
        btoa: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        performance: "readonly",
        process: "readonly",
        queueMicrotask: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      "no-control-regex": "off",
      "no-redeclare": "off",
      "no-regex-spaces": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        __filename: "readonly",
        exports: "writable",
        module: "writable",
        require: "readonly",
      },
    },
  },
  {
    files: [
      "packages/policy-engine/scripts/capture-mission-control-screenshots.mjs",
      "scripts/verification/lib/scenarios.mjs",
      "scripts/verification/lib/scenarios/**/*.mjs",
    ],
    languageOptions: {
      globals: {
        HTMLElement: "readonly",
        NodeFilter: "readonly",
        NodeList: "readonly",
        PerformanceObserver: "readonly",
        document: "readonly",
        getComputedStyle: "readonly",
        location: "readonly",
        navigator: "readonly",
        window: "readonly",
      },
    },
  },
  {
    files: ["**/public/sw.js"],
    languageOptions: {
      globals: {
        caches: "readonly",
        self: "readonly",
      },
    },
  },
  {
    files: ["scripts/lib/**/*.js"],
    languageOptions: {
      globals: {
        exports: "writable",
        require: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // typescript-eslint's eslint-recommended turns no-dupe-keys off because tsc
      // reports TS1117 instead. That delegation has a hole: every package tsconfig
      // excludes **/*.test.ts, so duplicate keys in test files are checked by
      // nobody and surface only as a vite "Duplicate key" build warning. Re-enable
      // the syntactic check so a silently-overridden key fails lint.
      "no-dupe-keys": "error",
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "max-lines": ["warn", { max: 1000, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: [
      "apps/gateway/src/services/llm-completion-service.ts",
      "packages/gateway-core/src/channel-core.ts",
      "packages/mission-control-shared/src/components/chat/ChatThreadPrimitives.tsx",
    ],
    rules: {
      "max-lines": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-console": "off",
      "max-lines": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: [
      "apps/gateway/src/**/*cli.ts",
      "apps/gateway/src/config-sync.ts",
      "fixtures/**/*.ts",
      "scripts/**/*.ts",
      "workspace/fixtures/**/*.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
  // React Hooks correctness for the shipped Mission Control surfaces. Scoped to
  // mission-control-next and its two shared React owners (the retired legacy app is excluded).
  // The CI lint gate uses --max-warnings 0, so both hook correctness lanes must
  // fail loudly instead of producing warning-only async guard drift.
  {
    files: [
      "apps/mission-control-next/**/*.{ts,tsx}",
      "packages/mission-control-shared/**/*.{ts,tsx}",
      "packages/threaded-surface-core/**/*.{ts,tsx}",
    ],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
