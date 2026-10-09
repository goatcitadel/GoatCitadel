import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CHANGED_BASE_REF = "origin/main";

// Each package-owned test command, keyed by the workspace packages whose change
// (directly or through a workspace dependency) requires it. Commands not listed
// here are prerequisites or whole-repo checks and always run.
export const FAST_LANE_COMMAND_PACKAGE_PREFIXES = Object.freeze([
  { prefix: "fast.test.gateway.", packages: ["@goatcitadel/gateway"] },
  { prefix: "fast.coverage.gateway.", packages: ["@goatcitadel/gateway"] },
  { prefix: "fast.smoke", packages: ["@goatcitadel/gateway"] },
  { prefix: "fast.test.storage.", packages: ["@goatcitadel/storage"] },
  { prefix: "fast.test.mission-control-next", packages: ["@goatcitadel/mission-control-next"] },
  { prefix: "fast.test.policy-engine", packages: ["@goatcitadel/policy-engine"] },
]);

// Paths outside workspace packages that cannot change any package test result.
// Every other non-package path (root configs, lockfile, scripts, shared vitest
// settings) selects the whole lane, because it can change how every suite runs.
const NO_TEST_IMPACT_PATHS = Object.freeze([
  /^docs\//,
  /^\.github\//,
  /^\.claude\//,
  /^\.codex\//,
  /^[^/]+\.md$/,
  /^scripts\/packaging\//,
  /^scripts\/remote-worker\//,
  /^scripts\/install-smoke\//,
]);

const NATIVE_WINDOWS_PATHS = Object.freeze([
  /^apps\/remote-worker[^/]*\//,
  /^scripts\/packaging\/(build-)?remote-worker/,
  /^scripts\/remote-worker\//,
]);

/** Reads `apps/*` and `packages/*` manifests into name, directory and workspace dependencies. */
export function readWorkspacePackages(repoRoot) {
  const packages = [];
  for (const group of ["apps", "packages"]) {
    const groupRoot = path.join(repoRoot, group);
    if (!fs.existsSync(groupRoot)) continue;
    for (const entry of fs.readdirSync(groupRoot, { withFileTypes: true })) {
      const manifestPath = path.join(groupRoot, entry.name, "package.json");
      if (!entry.isDirectory() || !fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const dependencies = Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      })
        .filter(([, spec]) => String(spec).startsWith("workspace:"))
        .map(([name]) => name);
      packages.push({ name: manifest.name, dir: `${group}/${entry.name}`, dependencies });
    }
  }
  return packages;
}

/** The changed packages plus every workspace package that depends on one, transitively. */
export function expandToDependents(packages, changedNames) {
  const affected = new Set(changedNames);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (!affected.has(pkg.name) && pkg.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(pkg.name);
        grew = true;
      }
    }
  }
  return affected;
}

export function packageOwnersOfCommand(commandId, libraryPackages) {
  if (commandId === "fast.test.libraries") return [...libraryPackages];
  const match = FAST_LANE_COMMAND_PACKAGE_PREFIXES.find(({ prefix }) => commandId.startsWith(prefix));
  return match ? match.packages : undefined;
}

/**
 * Pure planning step: maps changed paths to the fast-lane commands that must run.
 * Returns `fullLane: true` (and no selection) when a path can affect every suite.
 */
export function planChangedFastLane({ changedPaths, packages, commandIds, libraryPackages }) {
  const normalized = [...new Set(changedPaths.map((file) => file.replaceAll("\\", "/")).filter(Boolean))].sort();
  const nativeWindowsChanged = normalized.some((file) => NATIVE_WINDOWS_PATHS.some((pattern) => pattern.test(file)));
  const changedPackages = new Set();
  const fullLaneTriggers = [];
  for (const file of normalized) {
    const owner = packages.find((pkg) => file.startsWith(`${pkg.dir}/`));
    if (owner) changedPackages.add(owner.name);
    else if (!NO_TEST_IMPACT_PATHS.some((pattern) => pattern.test(file))) fullLaneTriggers.push(file);
  }
  if (fullLaneTriggers.length > 0) {
    return { fullLane: true, fullLaneTriggers, changedPaths: normalized, nativeWindowsChanged };
  }
  const affectedPackages = expandToDependents(packages, changedPackages);
  const selected = [];
  const skipped = [];
  for (const id of commandIds) {
    const owners = packageOwnersOfCommand(id, libraryPackages);
    if (!owners || owners.some((name) => affectedPackages.has(name))) selected.push(id);
    else skipped.push(id);
  }
  return {
    fullLane: false,
    changedPaths: normalized,
    affectedPackages: [...affectedPackages].sort(),
    selection: new Set(selected),
    skipped,
    nativeWindowsChanged,
  };
}

/** Changed paths since the merge base with `baseRef`, plus uncommitted and untracked files. */
export function collectChangedPaths(repoRoot, baseRef, run = defaultGit) {
  let mergeBase;
  try {
    mergeBase = run(repoRoot, ["merge-base", baseRef, "HEAD"]).trim();
  } catch {
    throw new Error(`--changed could not find a merge base with "${baseRef}". Fetch it or pass --changed=<ref>.`);
  }
  const lines = [
    run(repoRoot, ["diff", "--name-only", `${mergeBase}`, "HEAD"]),
    run(repoRoot, ["diff", "--name-only", "HEAD"]),
    run(repoRoot, ["ls-files", "--others", "--exclude-standard"]),
  ].join("\n");
  return lines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function defaultGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

export function describeChangedFastLanePlan(plan, baseRef) {
  const lines = [`verify:fast --changed against ${baseRef}: ${plan.changedPaths.length} changed path(s).`];
  if (plan.fullLane) {
    lines.push(`Running the whole lane: ${plan.fullLaneTriggers.slice(0, 5).join(", ")}${plan.fullLaneTriggers.length > 5 ? ", ..." : ""} can affect every suite.`);
  } else {
    lines.push(`Affected packages: ${plan.affectedPackages.length > 0 ? plan.affectedPackages.join(", ") : "none"}.`);
    lines.push(`Skipping ${plan.skipped.length} unaffected command(s): ${plan.skipped.join(", ") || "none"}.`);
  }
  if (plan.nativeWindowsChanged) {
    lines.push("Remote-worker native paths changed: also run `pnpm verify:remote-worker:windows` on Windows.");
  }
  return lines.join("\n");
}
