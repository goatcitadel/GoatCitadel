import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runScenario, writeJson } from "../shared.mjs";

const GIB_BYTES = 1024n * 1024n * 1024n;
export const DEFAULT_USABILITY_MIN_FREE_GIB = 8n;

export function resolveUsabilityDiskThreshold(input = {}) {
  const sourceMode = String(input.sourceMode ?? "final")
    .trim()
    .toLowerCase();
  if (sourceMode !== "final" && sourceMode !== "exploratory") {
    throw new Error(`unsupported usability source mode ${sourceMode}; expected exploratory or final`);
  }

  const rawOverride = input.minimumFreeGiB;
  const hasOverride = rawOverride !== undefined && rawOverride !== null && String(rawOverride).trim() !== "";
  const normalized = hasOverride ? String(rawOverride).trim() : String(DEFAULT_USABILITY_MIN_FREE_GIB);
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new Error("GOATCITADEL_USABILITY_MIN_FREE_GIB must be a positive whole number");
  }

  const minimumFreeGiB = BigInt(normalized);
  if (sourceMode === "final" && minimumFreeGiB < DEFAULT_USABILITY_MIN_FREE_GIB) {
    throw new Error(
      `final usability verification cannot lower GOATCITADEL_USABILITY_MIN_FREE_GIB below ${DEFAULT_USABILITY_MIN_FREE_GIB}`,
    );
  }
  return {
    sourceMode,
    source: hasOverride ? "environment" : "default",
    minimumFreeGiB,
    minimumFreeBytes: minimumFreeGiB * GIB_BYTES,
  };
}

export async function inspectUsabilityDiskCapacity(input, deps = {}) {
  const statfs = deps.statfs ?? fs.statfs;
  const mkdir = deps.mkdir ?? fs.mkdir;
  const minimumFreeBytes = BigInt(input.minimumFreeBytes);
  const targets = [
    { role: "repository", path: path.resolve(input.repoRoot), ensure: false },
    { role: "temporary", path: path.resolve(input.tempRoot), ensure: true },
  ];
  const roots = [];

  for (const target of targets) {
    try {
      if (target.ensure) await mkdir(target.path, { recursive: true });
      const stats = await statfs(target.path, { bigint: true });
      const availableBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
      roots.push({
        role: target.role,
        path: target.path,
        availableBytes: String(availableBytes),
        availableGiB: toGiB(availableBytes),
        status: availableBytes >= minimumFreeBytes ? "passed" : "failed",
      });
    } catch (error) {
      roots.push({
        role: target.role,
        path: target.path,
        availableBytes: null,
        availableGiB: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    status: roots.every((root) => root.status === "passed") ? "passed" : "failed",
    roots,
  };
}

export async function runUsabilityDiskCapacityPreflight(context, options = {}, deps = {}) {
  const runScenarioImpl = deps.runScenario ?? runScenario;
  const writeJsonImpl = deps.writeJson ?? writeJson;
  const env = options.env ?? process.env;
  const reportPath = path.join(context.artifactRoot, "diagnostics", "usability-disk-preflight.json");
  let failureMessage;

  const scenario = await runScenarioImpl(
    context,
    {
      id: "usability.preflight.disk-capacity",
      lane: "usability",
      title: "Repository and temporary volumes have capacity for the full usability campaign",
      subsystem: "verification-environment",
    },
    async () => {
      let threshold;
      let capacity = { status: "failed", roots: [] };
      let configurationError;
      try {
        threshold = resolveUsabilityDiskThreshold({
          sourceMode: env.GOATCITADEL_USABILITY_SOURCE_MODE,
          minimumFreeGiB: env.GOATCITADEL_USABILITY_MIN_FREE_GIB,
        });
        capacity = await inspectUsabilityDiskCapacity(
          {
            repoRoot: options.repoRoot ?? context.repoRoot,
            tempRoot: options.tempRoot ?? (env.GOATCITADEL_VERIFY_TEMP_ROOT?.trim() || os.tmpdir()),
            minimumFreeBytes: threshold.minimumFreeBytes,
          },
          deps,
        );
      } catch (error) {
        configurationError = error instanceof Error ? error.message : String(error);
      }

      failureMessage = configurationError ?? formatCapacityFailure(capacity.roots, threshold);
      const report = {
        schemaVersion: 1,
        generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
        status: configurationError ? "failed" : capacity.status,
        sourceMode: threshold?.sourceMode ?? String(env.GOATCITADEL_USABILITY_SOURCE_MODE ?? "final"),
        threshold: threshold
          ? {
              source: threshold.source,
              minimumFreeGiB: String(threshold.minimumFreeGiB),
              minimumFreeBytes: String(threshold.minimumFreeBytes),
            }
          : null,
        roots: capacity.roots,
        configurationError,
      };
      await writeJsonImpl(reportPath, report);
      const failedProbeCount = capacity.roots.filter((root) => root.status !== "passed").length;
      return {
        status: report.status,
        error: report.status === "failed" ? failureMessage : undefined,
        notes: [
          "This environment preflight is scoped to the direct usability campaign and does not certify product behavior.",
        ],
        metrics: {
          minimumFreeGiB: threshold ? Number(threshold.minimumFreeGiB) : 0,
          probeCount: capacity.roots.length,
          failedProbeCount,
        },
        artifacts: {
          diagnostics: [path.relative(context.artifactRoot, reportPath).replaceAll("\\", "/")],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
      };
    },
  );

  if (scenario.status !== "passed") {
    throw new Error(failureMessage ?? scenario.error ?? "usability disk-capacity preflight failed");
  }
  return scenario;
}

function formatCapacityFailure(roots, threshold) {
  const failures = roots.filter((root) => root.status !== "passed");
  if (failures.length === 0) return undefined;
  const required = threshold ? `${threshold.minimumFreeGiB} GiB` : "the configured reserve";
  const details = failures
    .map((root) =>
      root.availableGiB === null
        ? `${root.role} volume could not be measured${root.error ? ` (${root.error})` : ""}`
        : `${root.role} volume has ${root.availableGiB} GiB available`,
    )
    .join("; ");
  return `usability disk-capacity preflight requires ${required} on repository and temporary volumes: ${details}. Free space or point GOATCITADEL_VERIFY_TEMP_ROOT at a volume with sufficient capacity.`;
}

function toGiB(bytes) {
  return Math.round((Number(bytes) / Number(GIB_BYTES)) * 100) / 100;
}
