#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { acquireWorktreeOutputLock } from "../../../scripts/lib/worktree-output-lock.mjs";

const currentFile = fileURLToPath(import.meta.url);
const packageDir = path.resolve(path.dirname(currentFile), "..");
const repoRoot = path.resolve(packageDir, "..", "..");

export async function buildExtensionsSdkDist(options = {}) {
  const sourcePackageDir = path.resolve(options.packageDir ?? packageDir);
  const sourceRepoRoot = path.resolve(options.repoRoot ?? repoRoot);
  const publicationRoot = path.join(sourcePackageDir, ".tmp", "dist-publication");
  const distPath = path.join(sourcePackageDir, "dist");
  const stagedDistPath = path.join(publicationRoot, "next-dist");
  const previousDistPath = path.join(publicationRoot, "previous-dist");
  const temporaryConfigPath = path.join(publicationRoot, "tsconfig.json");
  const outputLockLease = await acquireWorktreeOutputLock({
    environment: options.environment,
    repoRoot: sourceRepoRoot,
    owner: "build:extensions-sdk",
  });

  try {
    await recoverInterruptedPublication({ distPath, previousDistPath });
    await fs.rm(publicationRoot, { recursive: true, force: true });
    await fs.mkdir(publicationRoot, { recursive: true });
    await fs.writeFile(
      temporaryConfigPath,
      `${JSON.stringify(
        {
          extends: "../../tsconfig.json",
          compilerOptions: {
            outDir: "./next-dist",
            // Source maps are consumed after next-dist is promoted to dist.
            // Anchor them to that final location rather than the temporary
            // publication directory used during compilation.
            sourceRoot: "../src",
            tsBuildInfoFile: "./next.tsbuildinfo",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const runCompiler = options.runCompiler ?? runTypeScriptBuild;
    await runCompiler({ packageDir: sourcePackageDir, projectPath: temporaryConfigPath });
    await assertStagedOutput(stagedDistPath);
    await publishStagedDirectory({ distPath, stagedDistPath, previousDistPath });

    // The canonical project did not produce this build-info file. Leaving an
    // older one beside tsconfig.json can make a later `tsc -b` trust outputs
    // that were just replaced by the staged publication.
    await fs.rm(path.join(sourcePackageDir, "tsconfig.tsbuildinfo"), { force: true });
  } finally {
    try {
      // If publication was interrupted after the old tree moved aside, restore
      // it before cleaning staging. Never erase the only complete tree merely
      // because the new-tree rename or its first rollback failed.
      await recoverInterruptedPublication({ distPath, previousDistPath });
      const preserveRecoveryTree = !(await pathExists(distPath)) && (await pathExists(previousDistPath));
      if (!preserveRecoveryTree) {
        await fs.rm(publicationRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      await outputLockLease.release();
    }
  }
}

export async function recoverInterruptedPublication({ distPath, previousDistPath }) {
  const distExists = await pathExists(distPath);
  const previousExists = await pathExists(previousDistPath);
  if (!distExists && previousExists) {
    await fs.mkdir(path.dirname(distPath), { recursive: true });
    await fs.rename(previousDistPath, distPath);
    return "restored";
  }
  if (distExists && previousExists) {
    await fs.rm(previousDistPath, { recursive: true, force: true });
    return "discarded_previous";
  }
  return "none";
}

export async function publishStagedDirectory(options) {
  const rename = options.rename ?? fs.rename;
  const remove = options.remove ?? fs.rm;
  const distExists = await pathExists(options.distPath);
  await remove(options.previousDistPath, { recursive: true, force: true });
  if (distExists) {
    await rename(options.distPath, options.previousDistPath);
  }
  try {
    await rename(options.stagedDistPath, options.distPath);
  } catch (error) {
    if (distExists && (await pathExists(options.previousDistPath))) {
      await remove(options.distPath, { recursive: true, force: true });
      await rename(options.previousDistPath, options.distPath);
    }
    throw error;
  }
  await remove(options.previousDistPath, { recursive: true, force: true });
}

async function assertStagedOutput(stagedDistPath) {
  for (const fileName of ["index.js", "index.d.ts"]) {
    try {
      await fs.access(path.join(stagedDistPath, fileName));
    } catch {
      throw new Error(`Extensions SDK staged build omitted ${fileName}.`);
    }
  }
}

async function runTypeScriptBuild({ packageDir: cwd, projectPath }) {
  const invocation = resolvePnpmInvocation();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, "exec", "tsc", "-b", projectPath], {
      cwd,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Extensions SDK staged TypeScript build failed with exit code ${exitCode}.`);
}

function resolvePnpmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return { command: process.execPath, prefixArgs: [npmExecPath] };
  }
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "pnpm.cmd"],
    };
  }
  return { command: "pnpm", prefixArgs: [] };
}

async function pathExists(targetPath) {
  return await fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

if (path.resolve(process.argv[1] ?? "") === currentFile) {
  buildExtensionsSdkDist().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
