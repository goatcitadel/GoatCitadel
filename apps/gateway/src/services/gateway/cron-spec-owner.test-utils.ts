import type { CronJobRecord } from "@goatcitadel/contracts";
import type { CronJobRuntimeTelemetryPatch, CronJobSpecInput, CronJobSpecPatch } from "@goatcitadel/storage";
import type { CronSpecMutationOwner } from "../cron-config-generation-owner.js";

interface TestCronJobRepository {
  get(jobId: string): CronJobRecord | undefined;
  createSpec(spec: CronJobSpecInput): CronJobRecord;
  updateSpecWithRevision(jobId: string, patch: CronJobSpecPatch, expectedRevision: number): CronJobRecord;
  mergeRuntimeTelemetry(jobId: string, patch: CronJobRuntimeTelemetryPatch): CronJobRecord;
  deleteWithRevision(jobId: string, expectedRevision: number): boolean;
  reconcileSpec?(spec: CronJobSpecInput): CronJobRecord;
}

/** Test-only synchronous-repository adapter for CronAutomationService unit fakes. */
export function createTestCronSpecOwner(repository: unknown): CronSpecMutationOwner {
  const cronJobs = repository as TestCronJobRepository;
  return {
    createSpec: async (spec, telemetry) => {
      let saved = cronJobs.createSpec(spec);
      if (telemetry && Object.keys(telemetry).length > 0) {
        saved = cronJobs.mergeRuntimeTelemetry(spec.jobId, telemetry);
      }
      return saved;
    },
    updateSpec: async (spec, expectedRevision, telemetry) => {
      const before = cronJobs.get(spec.jobId);
      let saved = cronJobs.updateSpecWithRevision(spec.jobId, fullPatch(spec), expectedRevision);
      if (before && saved.revision !== before.revision && telemetry && Object.keys(telemetry).length > 0) {
        saved = cronJobs.mergeRuntimeTelemetry(spec.jobId, telemetry);
      }
      return saved;
    },
    deleteSpec: async (jobId, expectedRevision) => cronJobs.deleteWithRevision(jobId, expectedRevision),
    reconcileSpec: async (spec) => {
      if (cronJobs.reconcileSpec) {
        return cronJobs.reconcileSpec(spec);
      }
      const current = cronJobs.get(spec.jobId);
      if (!current) {
        return cronJobs.createSpec(spec);
      }
      return cronJobs.updateSpecWithRevision(spec.jobId, fullPatch(spec), current.revision);
    },
  };
}

function fullPatch(spec: CronJobSpecInput): CronJobSpecPatch {
  return {
    name: spec.name,
    action: spec.action,
    actionConfig: spec.actionConfig ?? null,
    description: spec.description ?? null,
    schedule: spec.schedule,
    enabled: spec.enabled,
    endAt: spec.endAt ?? null,
    workdir: spec.workdir ?? null,
    contextFrom: spec.contextFrom ?? null,
  };
}
