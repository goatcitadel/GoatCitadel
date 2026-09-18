import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./shared.mjs";

export async function readArchitectureServiceAllowances(rootDir = repoRoot) {
  return JSON.parse(
    await fs.readFile(
      path.join(rootDir, "scripts/verification/baselines/architecture-new-service-allowances.json"),
      "utf8",
    ),
  );
}

/** Reviewed new owners only. Never edit or relax the original baseline. */
export function applyArchitectureServiceAllowances(baseline, document) {
  if (document === undefined) return baseline;
  const fail = () => {
    throw new Error("Invalid architecture new-service allowance; existing-owner limits cannot be increased.");
  };
  const servicePath = (value) =>
    typeof value === "string" &&
    /^apps\/gateway\/src\/services\/(?:[a-z0-9][a-z0-9.-]*\/)*[a-z0-9][a-z0-9.-]*\.ts$/u.test(value) &&
    !value.endsWith(".test.ts");
  if (
    !document ||
    document.schemaVersion !== 1 ||
    document.baselineMeasuredSourceSha256 !== baseline.measuredSourceSha256 ||
    !/^[a-f0-9]{40}$/u.test(document.baselineInventoryCommit ?? "") ||
    !Array.isArray(document.existingServicePaths) ||
    document.existingServicePaths.length === 0 ||
    !document.existingServicePaths.every(servicePath) ||
    new Set(document.existingServicePaths).size !== document.existingServicePaths.length ||
    !Array.isArray(document.entries)
  )
    fail();
  const existing = new Set(document.existingServicePaths);
  for (const name of [
    ...Object.keys(baseline.hostCallbacksByFile),
    ...Object.keys(baseline.dependencyMemberAccessesByFile),
  ]) {
    if (!existing.has(name)) fail();
  }
  const effective = {
    ...baseline,
    hostCallbacksByFile: { ...baseline.hostCallbacksByFile },
    dependencyMemberAccessesByFile: { ...baseline.dependencyMemberAccessesByFile },
  };
  const seen = new Set();
  for (const entry of document.entries) {
    if (
      !entry ||
      !servicePath(entry.path) ||
      existing.has(entry.path) ||
      seen.has(entry.path) ||
      !/^C[0-6]$/u.test(entry.planStep ?? "") ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length < 20 ||
      typeof entry.evidence !== "string" ||
      entry.evidence.trim().length < 10 ||
      ![entry.maxHostCallbacks, entry.maxDependencyMemberAccesses].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      fail();
    seen.add(entry.path);
    effective.hostCallbacksByFile[entry.path] = entry.maxHostCallbacks;
    effective.dependencyMemberAccessesByFile[entry.path] = entry.maxDependencyMemberAccesses;
    effective.totalHostCallbacks += entry.maxHostCallbacks;
    effective.totalDependencyMemberAccesses += entry.maxDependencyMemberAccesses;
    if (entry.path.startsWith("apps/gateway/src/services/chat-"))
      effective.chatHostCallbackCount += entry.maxHostCallbacks;
  }
  return effective;
}
