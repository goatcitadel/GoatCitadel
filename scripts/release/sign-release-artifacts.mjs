#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const args = parseArgs(process.argv.slice(2));
const artifactsDir = path.resolve(args.artifactsDir ?? path.join(repoRoot, "release-artifacts"));
const requireSigning = args.requireSigning !== false;

if (!fs.existsSync(artifactsDir)) {
  throw new Error(`Artifacts directory does not exist: ${artifactsDir}`);
}

const artifactFiles = listArtifactFiles(artifactsDir);
if (artifactFiles.length === 0) {
  throw new Error(`No release artifacts were found in ${artifactsDir}`);
}

for (const artifactPath of artifactFiles) {
  const checksum = sha256File(artifactPath);
  fs.writeFileSync(`${artifactPath}.sha256`, `${checksum}  ${path.basename(artifactPath)}\n`, "utf8");
}

const cosignPath = resolveExecutable("cosign");
if (!cosignPath) {
  if (requireSigning) {
    throw new Error("cosign was not found on PATH and signing is required.");
  }
  process.exit(0);
}

for (const artifactPath of artifactFiles) {
  const signaturePath = `${artifactPath}.sig`;
  const certificatePath = `${artifactPath}.pem`;
  const result = spawnSync(
    cosignPath,
    ["sign-blob", "--yes", "--output-signature", signaturePath, "--output-certificate", certificatePath, artifactPath],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        COSIGN_YES: "true",
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`cosign sign-blob failed for ${artifactPath} with exit code ${result.status}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    requireSigning: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--artifacts-dir") {
      parsed.artifactsDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--allow-unsigned") {
      parsed.requireSigning = false;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function listArtifactFiles(rootDir) {
  const files = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith(".sha256") || entry.name.endsWith(".sig") || entry.name.endsWith(".pem")) {
        continue;
      }
      if (
        entry.name.endsWith(".exe") ||
        entry.name.endsWith(".pkg") ||
        entry.name.endsWith(".zip") ||
        entry.name.endsWith(".tar.gz")
      ) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolveExecutable(command) {
  const executable = process.platform === "win32" ? `${command}.exe` : command;
  const result = spawnSync(executable, ["version"], {
    cwd: repoRoot,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  if (!result.error) {
    return executable;
  }
  return null;
}
