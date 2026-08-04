import fs from "node:fs";
import path from "node:path";

export function createPnpmBootstrapArgs(packageNames) {
  // `tsc -b` trusts tsbuildinfo even when ignored dist outputs were deleted, so
  // force a real re-emit. Serialize overlapping project-reference graphs to
  // keep dependents from racing while they rewrite shared declaration outputs.
  return [
    "--workspace-concurrency=1",
    ...packageNames.flatMap((packageName) => ["--filter", packageName]),
    "build",
    "--force",
  ];
}

export function normalizeBootstrapMode(value, warn = console.warn) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "always" || normalized === "force" || normalized === "1" || normalized === "true") {
    return "always";
  }
  if (normalized === "skip" || normalized === "never" || normalized === "0" || normalized === "false") {
    return "skip";
  }
  if (normalized === "auto") {
    return "auto";
  }
  warn(`[dev] ignoring unknown bootstrap mode "${value}"; expected auto, always, or skip`);
  return undefined;
}

export function resolveBootstrapPlan(rootDir, packageNames, mode) {
  if (mode === "always") {
    return {
      shouldBuild: true,
      packages: [...packageNames],
      reason: "forced by bootstrap mode",
    };
  }
  if (mode === "skip") {
    return {
      shouldBuild: false,
      packages: [],
      reason: "forced by bootstrap mode",
    };
  }

  const stale = [];
  const staleReasons = [];
  for (const packageName of packageNames) {
    const freshness = readWorkspacePackageFreshness(rootDir, packageName);
    if (!freshness.fresh) {
      stale.push(packageName);
      staleReasons.push(`${packageName}${freshness.reason ? ` (${freshness.reason})` : ""}`);
    }
  }

  if (stale.length === 0) {
    return {
      shouldBuild: false,
      packages: [],
      reason: "all runtime package dist outputs are newer than inputs",
    };
  }

  return {
    shouldBuild: true,
    packages: stale,
    reason: `stale or missing outputs: ${staleReasons.join(", ")}`,
  };
}

export function readWorkspacePackageFreshness(rootDir, packageName) {
  const packageDir = findWorkspacePackageDir(rootDir, packageName);
  if (!packageDir) {
    return { fresh: false, reason: "package not found" };
  }
  const distDir = path.join(packageDir, "dist");
  if (!fs.existsSync(distDir)) {
    return { fresh: false, reason: "missing dist" };
  }

  const inputMtime = newestMtime([
    path.join(packageDir, "src"),
    path.join(packageDir, "scripts"),
    path.join(packageDir, "package.json"),
    ...findTsconfigFiles(packageDir),
  ]);
  const outputMtime = newestMtime([distDir], (filePath) => /\.(?:js|d\.ts|json|map)$/u.test(filePath));

  if (inputMtime === undefined) {
    return { fresh: false, reason: "missing inputs" };
  }
  if (outputMtime === undefined) {
    return { fresh: false, reason: "missing dist outputs" };
  }
  if (inputMtime > outputMtime + 1) {
    return { fresh: false, reason: "inputs newer than dist" };
  }
  return { fresh: true };
}

function findWorkspacePackageDir(rootDir, packageName) {
  for (const workspaceRoot of ["packages", "apps"]) {
    const parent = path.join(rootDir, workspaceRoot);
    if (!fs.existsSync(parent)) {
      continue;
    }
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = path.join(parent, entry.name, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        if (packageJson.name === packageName) {
          return path.dirname(packageJsonPath);
        }
      } catch {
        // Treat unreadable package metadata as not found so the bootstrap rebuilds.
      }
    }
  }
  return undefined;
}

function findTsconfigFiles(packageDir) {
  return fs
    .readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^tsconfig(?:\..+)?\.json$/u.test(entry.name))
    .map((entry) => path.join(packageDir, entry.name));
}

function newestMtime(pathsToCheck, fileFilter) {
  let newest;
  for (const candidate of pathsToCheck) {
    for (const mtime of collectMtimes(candidate, fileFilter)) {
      newest = newest === undefined ? mtime : Math.max(newest, mtime);
    }
  }
  return newest;
}

function collectMtimes(targetPath, fileFilter = () => true) {
  if (!fs.existsSync(targetPath)) {
    return [];
  }
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return fileFilter(targetPath) ? [stat.mtimeMs] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const mtimes = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    mtimes.push(...collectMtimes(path.join(targetPath, entry.name), fileFilter));
  }
  return mtimes;
}
