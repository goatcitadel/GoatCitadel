#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const storageSourceRoot = path.join(repoRoot, "packages", "storage", "src");
const lifecycleSourceRoot = path.join(repoRoot, "apps", "gateway", "src");
const migrationName = /(?:migration|schema|sqlite|postgres)/i;
const sharedHostMarker = /\bshared(?:[_ -])host(?:[_ -](?:lifecycle|drain|reservation|admission))?\b/i;
const ddlMarker = /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX)\b/i;

const storageFiles = walk(storageSourceRoot).filter(
  (filePath) => filePath.endsWith(".ts") && migrationName.test(path.basename(filePath)),
);
const lifecycleFiles = walk(lifecycleSourceRoot).filter(
  (filePath) => filePath.endsWith(".ts") && path.basename(filePath).includes("shared-host"),
);

const migrationMatches = findMatches(storageFiles, sharedHostMarker);
const lifecycleDdlMatches = findMatches(lifecycleFiles, ddlMarker);
const proof = {
  version: "shared_host.no_migration_proof.v1",
  status: migrationMatches.length === 0 && lifecycleDdlMatches.length === 0 ? "passed" : "failed",
  checkedMigrationFiles: storageFiles.length,
  checkedLifecycleFiles: lifecycleFiles.length,
  migrationMarkerMatches: migrationMatches,
  lifecycleDdlMatches,
};

process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
if (proof.status !== "passed") process.exitCode = 1;

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function findMatches(files, pattern) {
  const matches = [];
  for (const filePath of files) {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      matches.push({
        file: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
        line: index + 1,
        text: line.trim().slice(0, 240),
      });
    });
  }
  return matches;
}
