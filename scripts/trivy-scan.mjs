#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const target = process.argv[2] ?? ".";
const trivyBinary = resolveTrivyBinary();
const version = spawnSync(trivyBinary, ["--version"], { stdio: "pipe", encoding: "utf8" });
if (version.status !== 0) {
  console.error("Trivy is not installed or not on PATH. Install it before running `pnpm security:trivy`.");
  process.exitCode = 1;
} else {
  const args = [
    "fs",
    "--scanners",
    "vuln,secret,misconfig",
    "--skip-dirs",
    "node_modules,tmp,apps/mission-control/dist-node,apps/gateway/backups,data/audit,data/transcripts",
    "--exit-code",
    "1",
    target,
  ];
  const result = spawnSync(trivyBinary, args, { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

function resolveTrivyBinary() {
  if (process.platform !== "win32") {
    return "trivy";
  }

  const candidates = [
    path.join("C:\\", "Program Files", "Trivy", "trivy.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Trivy", "trivy.exe"),
    path.join(process.env.USERPROFILE ?? "", "scoop", "shims", "trivy.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "trivy";
}
