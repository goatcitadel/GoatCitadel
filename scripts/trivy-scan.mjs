#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? ".";
const version = spawnSync("trivy", ["--version"], { stdio: "pipe", encoding: "utf8" });
if (version.status !== 0) {
  console.error("Trivy is not installed or not on PATH. Install it before running `pnpm security:trivy`.");
  process.exitCode = 1;
} else {
  const args = [
    "fs",
    "--scanners",
    "vuln,secret,config",
    "--skip-dirs",
    "node_modules,tmp,apps/mission-control/dist-node",
    "--exit-code",
    "1",
    target,
  ];
  const result = spawnSync("trivy", args, { stdio: "inherit", shell: process.platform === "win32" });
  process.exitCode = result.status ?? 1;
}
