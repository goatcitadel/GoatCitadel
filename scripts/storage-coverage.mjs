import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STORAGE_COVERAGE_SHARD_COUNT, storageCoverageShardDirectory } from "./coverage-shard-contract.mjs";
import { acquireWorktreeOutputLock } from "./lib/worktree-output-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const storageRoot = path.join(repoRoot, "packages", "storage");
const require = createRequire(import.meta.url);

// The fast lane builds storage once (`--build-only`) and then runs its shards
// against that output, concurrently when no live PostgreSQL is configured.
// Previously every shard deleted and rebuilt `dist`, so shards could never
// overlap and each rebuild invalidated downstream incremental builds.
export const STORAGE_COVERAGE_PREBUILT_ENV = "GOATCITADEL_STORAGE_COVERAGE_PREBUILT";

export function storageCoverageOptions(argv) {
  if (argv.length === 0) return { reportDirectory: "coverage", nodeArgs: [] };
  if (argv.length === 1 && argv[0] === "--build-only") return { buildOnly: true };
  const match = argv.length === 1 && /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(argv[0]);
  if (!match || Number(match[2]) !== STORAGE_COVERAGE_SHARD_COUNT || Number(match[1]) > Number(match[2])) {
    throw new Error(
      `Expected no arguments, --build-only, or --shard=N/${STORAGE_COVERAGE_SHARD_COUNT} with N between 1 and ${STORAGE_COVERAGE_SHARD_COUNT}.`,
    );
  }
  return {
    reportDirectory: storageCoverageShardDirectory(Number(match[1])),
    nodeArgs: [`--test-shard=${match[1]}/${match[2]}`],
  };
}

export function isPrebuiltStorageCoverage(environment = process.env) {
  return environment[STORAGE_COVERAGE_PREBUILT_ENV] === "1";
}

async function main() {
  // Validate before cleaning or building. An invalid shard must never run the
  // whole suite and report an apparently successful partial verification.
  const options = storageCoverageOptions(process.argv.slice(2));
  const prebuilt = !options.buildOnly && isPrebuiltStorageCoverage();
  if (prebuilt && !fs.existsSync(path.join(storageRoot, "dist"))) {
    throw new Error(`${STORAGE_COVERAGE_PREBUILT_ENV}=1 needs an existing storage build; run with --build-only first.`);
  }
  const lease = await acquireWorktreeOutputLock({ repoRoot, owner: "storage:test:coverage" });
  try {
    if (!prebuilt) cleanBuild();
    if (options.buildOnly) return;
    runNode([
      require.resolve("c8/bin/c8.js"), `--report-dir=${options.reportDirectory}`, `--temp-directory=${options.reportDirectory}/tmp`,
      "--reporter=json", "--reporter=text-summary", process.execPath,
      "--test", "--test-concurrency=1", ...options.nodeArgs, "--import", "tsx", "dist/**/*.test.js",
    ]);
  } finally {
    await lease.release();
  }
}

function cleanBuild() {
  fs.rmSync(path.join(storageRoot, "dist"), { recursive: true, force: true });
  fs.rmSync(path.join(storageRoot, "tsconfig.tsbuildinfo"), { force: true });
  const compiler = path.join(path.dirname(require.resolve("typescript-7/package.json")), "bin", "tsc");
  runNode([compiler, "-b", "tsconfig.json"]);
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: storageRoot, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Storage coverage command failed (${result.signal ?? result.status}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
