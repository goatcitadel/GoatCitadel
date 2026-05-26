import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

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
);
