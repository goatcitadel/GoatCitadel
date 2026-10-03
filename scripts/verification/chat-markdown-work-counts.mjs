import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Replay only renderer work in an ignored test copy. No checkout replacement,
// operator runtime, provider requests, output build or production telemetry.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const revision = process.argv[2];
if (!revision || !/^[a-f0-9]{7,40}$/u.test(revision)) throw new Error("Pass the reviewed checkpoint commit SHA");
const rendererRelative = "packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx";
const packageRoot = path.join(repoRoot, "packages/mission-control-shared");
const sourceDir = path.dirname(path.join(repoRoot, rendererRelative));
const temporaryDir = path.join(packageRoot, ".tmp/sf6-work-counts", revision);
await mkdir(temporaryDir, { recursive: true });
const baselineSource = execFileSync("git", ["show", `${revision}:${rendererRelative}`], {
  cwd: repoRoot,
  encoding: "utf8",
});
const nativeImport = (file) => file.replaceAll("\\", "/");
const baselinePath = path.join(temporaryDir, "baseline-renderer.tsx");
await writeFile(
  baselinePath,
  baselineSource.replace(
    /from\s+(["'])(\.[^"']+)\1/gu,
    (_match, _quote, specifier) => `from ${JSON.stringify(nativeImport(path.resolve(sourceDir, specifier)))}`,
  ),
);
const configPath = path.join(temporaryDir, "vitest.config.ts");
await writeFile(
  configPath,
  `import { defineConfig, mergeConfig } from "vitest/config";
import base from ${JSON.stringify(nativeImport(path.join(packageRoot, "vitest.config.ts")))};
export default mergeConfig(base, defineConfig({ resolve: { alias: [
  { find: "./AssistantMessageRenderer", replacement: ${JSON.stringify(nativeImport(baselinePath))} }
] } }));
`,
);
const testFile = "src/components/chat/AssistantMessageRenderer.work-counts.test.tsx";
const argumentsBase = [
  path.join(repoRoot, "node_modules/vitest/vitest.mjs"),
  "run",
  "--root",
  packageRoot,
  testFile,
  "--testNamePattern",
  "measures parsing",
];
console.log(`Before: ${revision}`);
execFileSync(process.execPath, [...argumentsBase, "--config", configPath], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, GOATCITADEL_SF6_BASELINE_MEASUREMENTS: "true" },
});
console.log("After: current renderer");
execFileSync(process.execPath, argumentsBase, {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, GOATCITADEL_SF6_BASELINE_MEASUREMENTS: "false" },
});
