import fs from "node:fs";
import path from "node:path";

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

/**
 * Validate retained scenario evidence before it is allowed to satisfy a required
 * proof binding. Artifact references are run-relative by contract: accepting an
 * absolute path, traversal, directory, symlink, or missing file would let a
 * manifest claim proof that the selected run did not actually retain.
 */
export function validateRequiredScenarioArtifacts(artifactRoot, scenarios) {
  const issues = [];
  const evidence = [];
  // Categories are orthogonal views: browser logs and traces also belong to the
  // Playwright rollup. A retained file still has one scenario owner and counts
  // only once as evidence, while repetition inside one category is invalid.
  const canonicalPathOwners = new Map();
  const root = resolveCanonicalArtifactRoot(artifactRoot, issues);
  if (!root) {
    return { evidence, issues };
  }

  for (const [scenarioOwner, scenario] of scenarios.entries()) {
    if (!scenario) continue;
    const scenarioId = typeof scenario.id === "string" && scenario.id.trim() ? scenario.id : "unknown-scenario";
    const artifacts = scenario.artifacts;
    if (artifacts === undefined || artifacts === null) continue;
    if (typeof artifacts !== "object" || Array.isArray(artifacts)) {
      issues.push({ scenarioId, reason: "invalid-artifact-container" });
      continue;
    }

    for (const [category, references] of Object.entries(artifacts)) {
      if (!Array.isArray(references)) {
        issues.push({ scenarioId, category, reason: "invalid-artifact-list" });
        continue;
      }
      const seenCategoryCanonicalPaths = new Set();
      for (const [index, reference] of references.entries()) {
        const validation = validateArtifactReference({
          root,
          scenarioId,
          scenarioOwner,
          category,
          index,
          reference,
          canonicalPathOwners,
          seenCategoryCanonicalPaths,
        });
        if (validation.issue) {
          issues.push(validation.issue);
        } else if (validation.isFirstCanonicalReference) {
          evidence.push(reference);
        }
      }
    }
  }

  return { evidence, issues };
}

export function assertNamedScenarioProofs(context, scenarioIds, label) {
  const failures = [];
  for (const scenarioId of scenarioIds) {
    const matches = context.manifest.scenarios.filter((scenario) => scenario.id === scenarioId);
    if (matches.length !== 1) {
      failures.push(`${scenarioId}:${matches.length === 0 ? "missing" : "duplicate"}`);
      continue;
    }
    const scenario = matches[0];
    if (scenario.status !== "passed") failures.push(`${scenarioId}:${scenario.status ?? "missing-status"}`);
    const validation = validateRequiredScenarioArtifacts(context.artifactRoot, [scenario]);
    if (validation.evidence.length === 0) failures.push(`${scenarioId}:evidence-missing`);
    for (const issue of validation.issues) {
      failures.push(`${scenarioId}:evidence-${formatArtifactIssue(issue)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${label} failed: ${failures.join(", ")}`);
}

export function formatArtifactIssue(issue) {
  const location =
    issue.category === undefined
      ? ""
      : issue.index === undefined
        ? `:${issue.category}`
        : `:${issue.category}[${issue.index}]`;
  const reference = issue.reference === undefined ? "" : `:${formatArtifactReference(issue.reference)}`;
  return `${issue.reason}${location}${reference}`;
}

function formatArtifactReference(reference) {
  try {
    return JSON.stringify(reference) ?? String(reference);
  } catch {
    return String(reference);
  }
}

function resolveCanonicalArtifactRoot(artifactRoot, issues) {
  if (typeof artifactRoot !== "string" || !artifactRoot.trim()) {
    issues.push({ reason: "invalid-artifact-root" });
    return undefined;
  }
  const absoluteRoot = path.resolve(artifactRoot);
  try {
    const stat = fs.lstatSync(absoluteRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      issues.push({ reason: "invalid-artifact-root" });
      return undefined;
    }
    return {
      absolute: absoluteRoot,
      canonical: fs.realpathSync(absoluteRoot),
    };
  } catch (error) {
    issues.push({
      reason: isMissingPathError(error) ? "missing-artifact-root" : "invalid-artifact-root",
    });
    return undefined;
  }
}

function validateArtifactReference({
  root,
  scenarioId,
  scenarioOwner,
  category,
  index,
  reference,
  canonicalPathOwners,
  seenCategoryCanonicalPaths,
}) {
  const baseIssue = { scenarioId, category, index, reference };
  if (typeof reference !== "string" || !reference.trim() || reference !== reference.trim()) {
    return { issue: { ...baseIssue, reason: "invalid-reference" } };
  }
  if (path.isAbsolute(reference) || WINDOWS_DRIVE_PREFIX.test(reference)) {
    return { issue: { ...baseIssue, reason: "absolute-reference" } };
  }
  if (reference.replaceAll("\\", "/").split("/").includes("..")) {
    return { issue: { ...baseIssue, reason: "traversal-reference" } };
  }

  const absolutePath = path.resolve(root.absolute, reference);
  if (!isWithinRoot(root.absolute, absolutePath)) {
    return { issue: { ...baseIssue, reason: "outside-artifact-root" } };
  }

  try {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { issue: { ...baseIssue, reason: "non-file-reference" } };
    }
    const canonicalPath = fs.realpathSync(absolutePath);
    if (!isWithinRoot(root.canonical, canonicalPath)) {
      return { issue: { ...baseIssue, reason: "outside-artifact-root" } };
    }
    const canonicalKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    const canonicalOwner = canonicalPathOwners.get(canonicalKey);
    if (
      seenCategoryCanonicalPaths.has(canonicalKey) ||
      (canonicalOwner !== undefined && canonicalOwner !== scenarioOwner)
    ) {
      return { issue: { ...baseIssue, reason: "duplicate-reference" } };
    }
    seenCategoryCanonicalPaths.add(canonicalKey);
    canonicalPathOwners.set(canonicalKey, scenarioOwner);
    return { isFirstCanonicalReference: canonicalOwner === undefined };
  } catch (error) {
    return {
      issue: {
        ...baseIssue,
        reason: isMissingPathError(error) ? "missing-reference" : "invalid-reference",
      },
    };
  }
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isMissingPathError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
