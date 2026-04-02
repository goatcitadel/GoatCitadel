import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const packageDir = path.resolve(currentDir, "..");
const packageJsonPath = path.join(packageDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const version = String(packageJson.version ?? "");

const prerelease = version.match(/-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)?$/);
const tag = prerelease?.[1] ?? "latest";
const args = ["publish", "--no-git-checks", "--tag", tag];

if (process.argv.includes("--dry-run")) {
  args.push("--dry-run");
}

const pnpmInvocation = resolvePnpmInvocation();
const result = spawnSync(pnpmInvocation.command, [...pnpmInvocation.prefixArgs, ...args], {
  cwd: packageDir,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

function resolvePnpmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      prefixArgs: [npmExecPath],
    };
  }

  const fallbackCommands = process.platform === "win32" ? ["pnpm.cmd", "pnpm"] : ["pnpm"];
  for (const candidate of fallbackCommands) {
    const probe = spawnSync(candidate, ["--version"], {
      cwd: packageDir,
      stdio: "ignore",
    });
    if (!probe.error && probe.status === 0) {
      return {
        command: candidate,
        prefixArgs: [],
      };
    }
  }

  return {
    command: fallbackCommands[0],
    prefixArgs: [],
  };
}
