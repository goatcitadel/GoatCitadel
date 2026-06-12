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
      "**/src-tauri/target/**",
      "**/artifacts/**",
      "vendor/**",
      "**/*.mjs",
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
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
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "max-lines": ["warn", { max: 1000, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
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
  // mission-control-next + mission-control-shared (the retired legacy app is excluded).
  // The CI lint gate uses --max-warnings 0, so both hook correctness lanes must
  // fail loudly instead of producing warning-only async guard drift.
  {
    files: [
      "apps/mission-control-next/**/*.{ts,tsx}",
      "packages/mission-control-shared/**/*.{ts,tsx}",
    ],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
