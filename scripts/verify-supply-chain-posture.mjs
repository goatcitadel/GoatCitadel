#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const LOCAL_SPEC_PREFIXES = ["workspace:", "link:", "file:", "portal:"];
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PINNED_PACKAGE_MANAGER_PATTERN = /^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function collectSupplyChainPostureFindings(input) {
  const rootDir = input.rootDir ?? process.cwd();
  const readTextFile =
    input.readTextFile ??
    ((relativePath) => fs.readFileSync(path.join(rootDir, normalizeRepoPath(relativePath)), "utf8"));
  const manifestPaths = (input.manifestPaths ?? listTrackedPackageManifests(rootDir)).map(normalizeRepoPath);
  const lockfileSource = input.lockfileSource ?? readTextFile("pnpm-lock.yaml");
  const lockfileImporters = parsePnpmLockImporters(lockfileSource);
  const lockfileOverrides = parsePnpmLockOverrides(lockfileSource);
  const findings = [];

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readTextFile(manifestPath));
    if (manifestPath === "package.json") {
      if (!PINNED_PACKAGE_MANAGER_PATTERN.test(String(manifest.packageManager ?? ""))) {
        findings.push({
          code: "UNPINNED_PACKAGE_MANAGER",
          filePath: manifestPath,
          message: "Root packageManager must pin pnpm to an exact version.",
        });
      }
      for (const [overrideKey, overrideValue] of Object.entries(manifest.pnpm?.overrides ?? {})) {
        if (typeof overrideValue === "string" && !isPinnedDependencySpecifier(overrideValue)) {
          findings.push({
            code: "UNPINNED_PNPM_OVERRIDE",
            filePath: manifestPath,
            dependencyName: overrideKey,
            message: `pnpm override '${overrideKey}' must resolve to an exact version or local protocol.`,
          });
        }
      }
    }

    const importerKey = manifestPath === "package.json" ? "." : path.posix.dirname(manifestPath);
    const lockfileImporter = lockfileImporters.get(importerKey);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependencyName, specifier] of Object.entries(manifest[field] ?? {})) {
        if (typeof specifier !== "string") {
          continue;
        }
        if (!isPinnedDependencySpecifier(specifier)) {
          findings.push({
            code: "UNPINNED_DIRECT_DEPENDENCY",
            filePath: manifestPath,
            dependencyName,
            message: `${field}.${dependencyName} must use an exact version or local protocol, not '${specifier}'.`,
          });
        }
        const lockfileDependency = lockfileImporter?.get(field)?.get(dependencyName);
        if (!lockfileDependency) {
          continue;
        }
        if (lockfileDependency.specifier !== specifier) {
          findings.push({
            code: "LOCKFILE_SPECIFIER_MISMATCH",
            filePath: "pnpm-lock.yaml",
            dependencyName,
            message: `${importerKey} ${field}.${dependencyName} lockfile specifier '${lockfileDependency.specifier}' does not match manifest specifier '${specifier}'.`,
          });
        }
      }
    }
  }

  for (const [overrideKey, overrideValue] of lockfileOverrides) {
    if (!isPinnedDependencySpecifier(overrideValue)) {
      findings.push({
        code: "UNPINNED_LOCKFILE_OVERRIDE",
        filePath: "pnpm-lock.yaml",
        dependencyName: overrideKey,
        message: `Lockfile override '${overrideKey}' must resolve to an exact version or local protocol.`,
      });
    }
  }

  findings.push(...collectInstallerUpdatePostureFindings({ rootDir, readTextFile }));

  return findings;
}

export function collectInstallerUpdatePostureFindings(input) {
  const rootDir = input.rootDir ?? process.cwd();
  const readTextFile =
    input.readTextFile ??
    ((relativePath) => fs.readFileSync(path.join(rootDir, normalizeRepoPath(relativePath)), "utf8"));
  const findings = [];

  for (const scriptPath of ["install.ps1", "install.sh", "bin/goatcitadel.mjs"]) {
    const source = readTextFile(scriptPath);
    if (!source.includes("--frozen-lockfile")) {
      findings.push({
        code: "INSTALLER_MUTABLE_LOCKFILE_INSTALL",
        filePath: scriptPath,
        message: "Installer/update path must run pnpm install with --frozen-lockfile by default.",
      });
    }
    if (!source.includes("GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH")) {
      findings.push({
        code: "INSTALLER_UNGOVERNED_LOCKFILE_REFRESH",
        filePath: scriptPath,
        message: "Installer/update lockfile refresh fallback must require the explicit GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH opt-in.",
      });
    }
  }

  for (const workflowPath of input.workflowPaths ?? listTrackedWorkflowFiles(rootDir)) {
    const source = readTextFile(workflowPath);
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        continue;
      }
      if (/\bpnpm\s+install\b/.test(trimmed) && !trimmed.includes("--frozen-lockfile")) {
        findings.push({
          code: "WORKFLOW_MUTABLE_LOCKFILE_INSTALL",
          filePath: workflowPath,
          message: "Workflow pnpm install steps must use --frozen-lockfile.",
        });
      }
    }
  }

  return findings;
}

export function isPinnedDependencySpecifier(specifier) {
  if (LOCAL_SPEC_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    return true;
  }
  if (specifier.startsWith("npm:")) {
    const aliasVersion = specifier.slice("npm:".length).split("@").pop();
    return Boolean(aliasVersion && EXACT_VERSION_PATTERN.test(aliasVersion));
  }
  return EXACT_VERSION_PATTERN.test(specifier);
}

export function parsePnpmLockImporters(source) {
  const importers = new Map();
  const lines = source.split(/\r?\n/);
  let inImporters = false;
  let importerKey = null;
  let dependencyField = null;
  let dependencyName = null;

  for (const line of lines) {
    if (line === "importers:") {
      inImporters = true;
      continue;
    }
    if (!inImporters) {
      continue;
    }
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    const importerMatch = /^  ([^ ].*):$/.exec(line);
    if (importerMatch) {
      importerKey = unquoteYamlKey(importerMatch[1]);
      importers.set(importerKey, new Map());
      dependencyField = null;
      dependencyName = null;
      continue;
    }
    const fieldMatch = /^    (dependencies|devDependencies|optionalDependencies|peerDependencies):$/.exec(line);
    if (fieldMatch && importerKey) {
      dependencyField = fieldMatch[1];
      if (!importers.get(importerKey)?.has(dependencyField)) {
        importers.get(importerKey)?.set(dependencyField, new Map());
      }
      dependencyName = null;
      continue;
    }
    const dependencyMatch = /^      ([^ ].*):$/.exec(line);
    if (dependencyMatch && importerKey && dependencyField) {
      dependencyName = unquoteYamlKey(dependencyMatch[1]);
      importers.get(importerKey)?.get(dependencyField)?.set(dependencyName, {});
      continue;
    }
    const propertyMatch = /^        (specifier|version): (.*)$/.exec(line);
    if (propertyMatch && importerKey && dependencyField && dependencyName) {
      const dependency = importers.get(importerKey)?.get(dependencyField)?.get(dependencyName);
      if (dependency) {
        dependency[propertyMatch[1]] = propertyMatch[2].trim();
      }
    }
  }

  return importers;
}

export function parsePnpmLockOverrides(source) {
  const overrides = new Map();
  const lines = source.split(/\r?\n/);
  let inOverrides = false;
  for (const line of lines) {
    if (line === "overrides:") {
      inOverrides = true;
      continue;
    }
    if (!inOverrides) {
      continue;
    }
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    const match = /^  (.+): (.+)$/.exec(line);
    if (match) {
      overrides.set(unquoteYamlKey(match[1]), match[2].trim());
    }
  }
  return overrides;
}

export function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function unquoteYamlKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed);
  }
  return trimmed;
}

function listTrackedPackageManifests(rootDir) {
  return execFileSync("git", ["ls-files", "package.json", "*/package.json", "*/*/package.json"], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("/node_modules/"));
}

function listTrackedWorkflowFiles(rootDir) {
  return execFileSync("git", ["ls-files", ".github/workflows/*.yml", ".github/workflows/*.yaml"], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const findings = collectSupplyChainPostureFindings({ rootDir: process.cwd() });
  if (findings.length > 0) {
    console.error("Supply-chain posture check failed:");
    for (const finding of findings) {
      const dependency = finding.dependencyName ? ` ${finding.dependencyName}` : "";
      console.error(`- [${finding.code}] ${finding.filePath}${dependency}: ${finding.message}`);
    }
    process.exit(1);
  }
  console.log("Supply-chain posture check passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
