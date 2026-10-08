#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listScriptTestFiles, selectScriptTestFiles } from "./script-test-partition.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export function parseScriptTestArgs(argv) {
  let suite = "hygiene";
  let concurrency = 2;
  for (const arg of argv) {
    const suiteMatch = /^--suite=(.+)$/.exec(arg);
    const concurrencyMatch = /^--test-concurrency=([1-9]\d*)$/.exec(arg);
    if (suiteMatch) suite = suiteMatch[1];
    else if (concurrencyMatch) concurrency = Number(concurrencyMatch[1]);
    else throw new Error(`Unexpected argument "${arg}". Expected --suite=<name> and/or --test-concurrency=<n>.`);
  }
  return { suite, concurrency };
}

function main() {
  const { suite, concurrency } = parseScriptTestArgs(process.argv.slice(2));
  const files = selectScriptTestFiles(listScriptTestFiles(repoRoot), suite);
  if (files.length === 0) {
    console.log(`No ${suite} script tests apply on ${process.platform}.`);
    return;
  }
  console.log(`Running ${files.length} ${suite} script test file(s).`);
  const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...files], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
