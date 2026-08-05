import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type CronJobAction,
  type CronJobActionConfig,
  type CronJobRecord,
} from "@goatcitadel/contracts";
import type {
  CronJobRuntimeTelemetryPatch,
  CronJobSpecInput,
  CronJobSpecPatch,
  AsyncStorage as Storage,
} from "@goatcitadel/storage";
import {
  ConfigGenerationApplyError,
  ConfigGenerationService,
  RuntimeOwnerApplyAlreadyRestoredError,
  type CompleteUnifiedConfigPayload,
} from "./config-generation-service.js";
import {
  computeNextCronRunAt,
  normalizeCronContextFrom,
  normalizeCronEndAt,
  normalizeCronJobDescription,
  normalizeCronJobId,
  normalizeCronJobName,
  normalizeCronSchedule,
  normalizeCronWorkdir,
} from "./gateway/cron-automation-service.js";
import {
  COST_REPORT_HOURLY_JOB_ID,
  IMPROVEMENT_WEEKLY_JOB_ID,
  MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./gateway/cron-job-ids.js";

const CRON_ACTIONS = new Set<CronJobAction>([
  "task",
  "improvement",
  "curator",
  "backup",
  "memory_flush",
  "memory_consolidation",
  "cost_report",
  "update_review",
  "watchdog",
  "no_agent",
  "agent_turn",
]);

const BUILT_IN_ACTIONS = new Map<string, CronJobAction>([
  [IMPROVEMENT_WEEKLY_JOB_ID, "improvement"],
  ["curator_weekly", "curator"],
  [PRIVATE_BETA_BACKUP_JOB_ID, "backup"],
  [MEMORY_FLUSH_DAILY_JOB_ID, "memory_flush"],
  [MEMORY_CONSOLIDATION_WEEKLY_JOB_ID, "memory_consolidation"],
  [COST_REPORT_HOURLY_JOB_ID, "cost_report"],
  [UPDATE_REVIEW_DAILY_JOB_ID, "update_review"],
]);

export interface CronConfigGenerationOwnerHooks {
  /** Fault-injection seam inside the Storage transaction. */
  afterStorageMutation?(mutation: CronStorageMutation): void;
}

export interface CronSpecMutationOwner {
  createSpec(spec: CronJobSpecInput, telemetry?: CronJobRuntimeTelemetryPatch): Promise<CronJobRecord>;
  updateSpec(
    spec: CronJobSpecInput,
    expectedRevision: number,
    telemetry?: CronJobRuntimeTelemetryPatch,
  ): Promise<CronJobRecord>;
  deleteSpec(jobId: string, expectedRevision: number): Promise<boolean>;
  reconcileSpec(spec: CronJobSpecInput): Promise<CronJobRecord>;
}

export type CronStorageMutation =
  | {
      kind: "create";
      spec: CronJobSpecInput;
      telemetry?: CronJobRuntimeTelemetryPatch;
    }
  | {
      kind: "update";
      spec: CronJobSpecInput;
      expectedRevision: number;
      telemetry?: CronJobRuntimeTelemetryPatch;
    }
  | {
      kind: "delete";
      jobId: string;
      expectedRevision: number;
    }
  | {
      kind: "reconcile_all";
      specs: CronJobSpecInput[];
      deleteExtraneous: boolean;
    };

type CronMutationResult = CronJobRecord | boolean | CronJobRecord[];

class CronConfigNoOp<T> extends Error {
  public constructor(public readonly result: T) {
    super("Cron config generation is already current.");
    this.name = "CronConfigNoOp";
  }
}

export class CronConfigGenerationOwner implements CronSpecMutationOwner {
  public constructor(
    private readonly configGeneration: ConfigGenerationService,
    private readonly storage: Pick<Storage, "cronJobs" | "runImmediateTransaction">,
    private readonly hooks: CronConfigGenerationOwnerHooks = {},
  ) {}

  public async createSpec(spec: CronJobSpecInput, telemetry?: CronJobRuntimeTelemetryPatch): Promise<CronJobRecord> {
    const desired = projectCanonicalCronSpec(spec);
    return await this.commitMutation<CronJobRecord>(async () => {
      const existing = await this.storage.cronJobs.get(desired.jobId);
      if (existing) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `cron_job ${desired.jobId} already exists`,
          details: {
            resourceKind: "cron_job",
            resourceId: desired.jobId,
            expectedRevision: 0,
            currentRevision: existing.revision,
          },
        });
      }
      return {
        mutation: { kind: "create", spec: desired, ...(telemetry ? { telemetry } : {}) },
        updateSpecs: (specs) => upsertCanonicalSpec(specs, desired),
      };
    });
  }

  public async updateSpec(
    spec: CronJobSpecInput,
    expectedRevision: number,
    telemetry?: CronJobRuntimeTelemetryPatch,
  ): Promise<CronJobRecord> {
    const desired = projectCanonicalCronSpec(spec);
    return await this.commitMutation<CronJobRecord>(async () => {
      const current = await this.requireExpectedRevision(desired.jobId, expectedRevision);
      return {
        mutation: {
          kind: "update",
          spec: desired,
          expectedRevision,
          ...(telemetry ? { telemetry } : {}),
        },
        updateSpecs: (specs) => upsertCanonicalSpec(specs, desired),
        noOpResult: cronJobSpecMatches(current, desired) ? current : undefined,
      };
    });
  }

  public async deleteSpec(jobId: string, expectedRevision: number): Promise<boolean> {
    const normalizedJobId = normalizeCronJobId(jobId);
    return await this.commitMutation<boolean>(async () => {
      await this.requireExpectedRevision(normalizedJobId, expectedRevision);
      return {
        mutation: { kind: "delete", jobId: normalizedJobId, expectedRevision },
        updateSpecs: (specs) => specs.filter((spec) => spec.jobId !== normalizedJobId),
      };
    });
  }

  public async reconcileSpec(spec: CronJobSpecInput): Promise<CronJobRecord> {
    const desired = projectCanonicalCronSpec(spec);
    return await this.commitMutation<CronJobRecord>(async () => {
      const current = await this.storage.cronJobs.get(desired.jobId);
      if (!current) {
        return {
          mutation: { kind: "create", spec: desired },
          updateSpecs: (specs) => upsertCanonicalSpec(specs, desired),
        };
      }
      return {
        mutation: { kind: "update", spec: desired, expectedRevision: current.revision },
        updateSpecs: (specs) => upsertCanonicalSpec(specs, desired),
        noOpResult: cronJobSpecMatches(current, desired) ? current : undefined,
      };
    });
  }

  /**
   * Normal startup migration. Canonical config wins for shared job IDs, while
   * legacy Storage-only jobs are adopted once so their telemetry is not lost.
   */
  public async reconcileStartupGeneration(): Promise<CronJobRecord[]> {
    let applied: CronJobRecord[] | undefined;
    try {
      await this.configGeneration.commit<CronStorageMutation>({
        requireExpectedRevision: false,
        previousRuntime: { kind: "reconcile_all", specs: [], deleteExtraneous: false },
        buildCandidate: async () => {
          const active = this.configGeneration.getActivePayload();
          const activeSpecs = readCanonicalCronSpecs(active.cronJobs);
          const merged = mergeStorageOnlySpecs(activeSpecs, await this.storage.cronJobs.list());
          const mutation: CronStorageMutation = {
            kind: "reconcile_all",
            specs: merged,
            deleteExtraneous: false,
          };
          if (unifiedCronSectionMatches(active.cronJobs, merged)) {
            throw new CronConfigNoOp(mutation);
          }
          return { payload: withCanonicalCronSpecs(active, merged), runtime: mutation };
        },
        apply: async (mutation) => {
          try {
            applied = (await this.applyStorageMutation(mutation)) as CronJobRecord[];
          } catch (error) {
            throw new RuntimeOwnerApplyAlreadyRestoredError(error);
          }
        },
        restore: () => undefined,
      });
    } catch (error) {
      if (error instanceof CronConfigNoOp) {
        return (await this.applyStorageMutation(error.result as CronStorageMutation)) as CronJobRecord[];
      }
      throw error;
    }
    if (!applied) {
      throw new Error("Cron startup generation committed without applying its Storage owner.");
    }
    return applied;
  }

  /**
   * A committed generation is an exact durable decision. Reapply its complete
   * spec projection before the transaction marker is cleared; runtime telemetry
   * on matching jobs is retained byte-for-byte.
   */
  public async reconcileCommittedGeneration(): Promise<CronJobRecord[]> {
    const specs = readCanonicalCronSpecs(this.configGeneration.getActivePayload().cronJobs);
    return (await this.applyStorageMutation({
      kind: "reconcile_all",
      specs,
      deleteExtraneous: true,
    })) as CronJobRecord[];
  }

  private async commitMutation<T extends CronMutationResult>(
    build: () => Promise<{
      mutation: CronStorageMutation;
      updateSpecs(specs: CronJobSpecInput[]): CronJobSpecInput[];
      noOpResult?: T;
    }>,
  ): Promise<T> {
    let applied: CronMutationResult | undefined;
    try {
      await this.configGeneration.commit<CronStorageMutation>({
        requireExpectedRevision: false,
        previousRuntime: { kind: "reconcile_all", specs: [], deleteExtraneous: false },
        buildCandidate: async () => {
          const active = this.configGeneration.getActivePayload();
          const currentSpecs = readCanonicalCronSpecs(active.cronJobs);
          const candidate = await build();
          const nextSpecs = sortCanonicalSpecs(candidate.updateSpecs(currentSpecs));
          const nextPayload = withCanonicalCronSpecs(active, nextSpecs);
          if (candidate.noOpResult !== undefined && unifiedCronSectionMatches(active.cronJobs, nextSpecs)) {
            throw new CronConfigNoOp(candidate.noOpResult);
          }
          if (candidate.mutation.kind === "reconcile_all" && unifiedCronSectionMatches(active.cronJobs, nextSpecs)) {
            throw new CronConfigNoOp(nextSpecs);
          }
          return { payload: nextPayload, runtime: candidate.mutation };
        },
        apply: async (mutation) => {
          try {
            applied = await this.applyStorageMutation(mutation);
          } catch (error) {
            throw new RuntimeOwnerApplyAlreadyRestoredError(error);
          }
        },
        // Storage apply is one immediate transaction. A thrown owner fault has
        // already rolled it back exactly, including telemetry and revision.
        restore: () => undefined,
      });
    } catch (error) {
      if (error instanceof CronConfigNoOp) {
        return error.result as T;
      }
      const resourceConflict = findResourceConflict(error);
      if (resourceConflict) {
        throw resourceConflict;
      }
      throw error;
    }
    if (applied === undefined) {
      throw new Error("Cron config generation committed without applying its Storage owner.");
    }
    return applied as T;
  }

  private async applyStorageMutation(mutation: CronStorageMutation): Promise<CronMutationResult> {
    return await this.storage.runImmediateTransaction(async () => {
      let result: CronMutationResult;
      if (mutation.kind === "create") {
        result = await this.storage.cronJobs.createSpec(mutation.spec);
        if (mutation.telemetry && hasTelemetryFields(mutation.telemetry)) {
          result = await this.storage.cronJobs.mergeRuntimeTelemetry(mutation.spec.jobId, mutation.telemetry);
        }
      } else if (mutation.kind === "update") {
        const before = await this.storage.cronJobs.get(mutation.spec.jobId);
        result = await this.storage.cronJobs.updateSpecWithRevision(
          mutation.spec.jobId,
          toFullSpecPatch(mutation.spec),
          mutation.expectedRevision,
        );
        if (
          before &&
          (result as CronJobRecord).revision !== before.revision &&
          mutation.telemetry &&
          hasTelemetryFields(mutation.telemetry)
        ) {
          result = await this.storage.cronJobs.mergeRuntimeTelemetry(mutation.spec.jobId, mutation.telemetry);
        }
      } else if (mutation.kind === "delete") {
        result = await this.storage.cronJobs.deleteWithRevision(mutation.jobId, mutation.expectedRevision);
      } else {
        result = await this.reconcileAllSpecs(mutation.specs, mutation.deleteExtraneous);
      }
      this.hooks.afterStorageMutation?.(mutation);
      return result;
    });
  }

  private async reconcileAllSpecs(specs: CronJobSpecInput[], deleteExtraneous: boolean): Promise<CronJobRecord[]> {
    const desiredIds = new Set(specs.map((spec) => spec.jobId));
    if (deleteExtraneous) {
      for (const existing of await this.storage.cronJobs.list()) {
        if (!desiredIds.has(existing.jobId)) {
          await this.storage.cronJobs.deleteWithRevision(existing.jobId, existing.revision);
        }
      }
    }

    const saved: CronJobRecord[] = [];
    for (const spec of specs) {
      const before = await this.storage.cronJobs.get(spec.jobId);
      const changed = !before || !cronJobSpecMatches(before, spec);
      let next = await this.storage.cronJobs.reconcileSpec(spec);
      if (changed) {
        next = await this.storage.cronJobs.mergeRuntimeTelemetry(spec.jobId, {
          nextRunAt: isSelfScheduledAction(spec.action)
            ? (computeNextCronRunAt(spec.schedule, new Date(), spec.endAt) ?? null)
            : null,
        });
      }
      saved.push(next);
    }
    return saved;
  }

  private async requireExpectedRevision(jobId: string, expectedRevision: number): Promise<CronJobRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ValidationError({ field: "expectedRevision" });
    }
    const current = await this.storage.cronJobs.get(jobId);
    if (!current) {
      throw new NotFoundError({ entity: "Cron job", id: jobId });
    }
    if (current.revision !== expectedRevision) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `cron_job ${jobId} changed since revision ${expectedRevision}`,
        details: {
          resourceKind: "cron_job",
          resourceId: jobId,
          expectedRevision,
          currentRevision: current.revision,
        },
      });
    }
    return current;
  }
}

export function projectCanonicalCronSpec(spec: CronJobSpecInput): CronJobSpecInput {
  const jobId = normalizeCronJobId(spec.jobId);
  const description = normalizeCronJobDescription(spec.description);
  const endAt = normalizeCronEndAt(spec.endAt);
  const workdir = normalizeCronWorkdir(spec.workdir);
  const contextFrom = normalizeCronContextFrom(spec.contextFrom);
  return {
    jobId,
    name: normalizeCronJobName(spec.name),
    action: normalizeCanonicalAction(jobId, spec.action),
    ...(spec.actionConfig ? { actionConfig: structuredClone(spec.actionConfig) } : {}),
    ...(description ? { description } : {}),
    schedule: normalizeCronSchedule(spec.schedule),
    enabled: spec.enabled,
    ...(endAt ? { endAt } : {}),
    ...(workdir ? { workdir } : {}),
    ...(contextFrom ? { contextFrom } : {}),
  };
}

export function readCanonicalCronSpecs(section: unknown): CronJobSpecInput[] {
  const jobs = Array.isArray(section)
    ? section
    : isRecord(section) && Array.isArray(section.jobs)
      ? section.jobs
      : undefined;
  if (!jobs) {
    throw new ValidationError({ message: "Canonical cronJobs section must contain a jobs array." });
  }
  const seen = new Set<string>();
  const specs = jobs.map((value, index) => {
    if (!isRecord(value)) {
      throw new ValidationError({ message: `Canonical cron job at index ${index} must be an object.` });
    }
    if (typeof value.jobId !== "string" || typeof value.name !== "string" || typeof value.schedule !== "string") {
      throw new ValidationError({
        message: `Canonical cron job at index ${index} is missing jobId, name, or schedule.`,
      });
    }
    const jobId = normalizeCronJobId(value.jobId);
    const action = normalizeCanonicalAction(jobId, value.action);
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      throw new ValidationError({ message: `Canonical cron job ${jobId} has a non-boolean enabled value.` });
    }
    const spec = projectCanonicalCronSpec({
      jobId,
      name: value.name,
      action,
      ...(isRecord(value.actionConfig)
        ? { actionConfig: structuredClone(value.actionConfig) as CronJobActionConfig }
        : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      schedule: value.schedule,
      enabled: value.enabled ?? true,
      ...(typeof value.endAt === "string" ? { endAt: value.endAt } : {}),
      ...(typeof value.workdir === "string" ? { workdir: value.workdir } : {}),
      ...(typeof value.contextFrom === "string" ? { contextFrom: value.contextFrom } : {}),
    });
    if (seen.has(spec.jobId)) {
      throw new ValidationError({ message: `Canonical cronJobs contains duplicate jobId ${spec.jobId}.` });
    }
    seen.add(spec.jobId);
    return spec;
  });
  return sortCanonicalSpecs(specs);
}

function normalizeCanonicalAction(jobId: string, value: unknown): CronJobAction {
  const builtIn = BUILT_IN_ACTIONS.get(jobId);
  if (builtIn) {
    return builtIn;
  }
  if (value === undefined) {
    return "task";
  }
  if (typeof value !== "string" || !CRON_ACTIONS.has(value as CronJobAction)) {
    throw new ValidationError({ message: `Canonical cron job ${jobId} has an unsupported action.` });
  }
  return value as CronJobAction;
}

function withCanonicalCronSpecs(
  payload: CompleteUnifiedConfigPayload,
  specs: CronJobSpecInput[],
): CompleteUnifiedConfigPayload {
  return {
    ...structuredClone(payload),
    cronJobs: { jobs: sortCanonicalSpecs(specs).map(projectCanonicalCronSpec) },
  };
}

function upsertCanonicalSpec(specs: CronJobSpecInput[], desired: CronJobSpecInput): CronJobSpecInput[] {
  return sortCanonicalSpecs([...specs.filter((spec) => spec.jobId !== desired.jobId), desired]);
}

function mergeStorageOnlySpecs(active: CronJobSpecInput[], stored: CronJobRecord[]): CronJobSpecInput[] {
  const merged = new Map(active.map((spec) => [spec.jobId, spec]));
  for (const record of stored) {
    if (!merged.has(record.jobId)) {
      merged.set(record.jobId, projectCanonicalCronSpec(record));
    }
  }
  return sortCanonicalSpecs([...merged.values()]);
}

function sortCanonicalSpecs(specs: CronJobSpecInput[]): CronJobSpecInput[] {
  return [...specs].map(projectCanonicalCronSpec).sort((left, right) => left.jobId.localeCompare(right.jobId));
}

function unifiedCronSectionMatches(section: unknown, specs: CronJobSpecInput[]): boolean {
  return deepEqualCanonical(section, { jobs: sortCanonicalSpecs(specs) });
}

function cronJobSpecMatches(record: CronJobRecord, spec: CronJobSpecInput): boolean {
  return deepEqualCanonical(projectCanonicalCronSpec(record), projectCanonicalCronSpec(spec));
}

function toFullSpecPatch(spec: CronJobSpecInput): CronJobSpecPatch {
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

function hasTelemetryFields(patch: CronJobRuntimeTelemetryPatch): boolean {
  return Object.keys(patch).length > 0;
}

function isSelfScheduledAction(action: CronJobAction): boolean {
  return (
    action === "task" ||
    action === "watchdog" ||
    action === "curator" ||
    action === "no_agent" ||
    action === "agent_turn"
  );
}

function findResourceConflict(error: unknown): ConflictError | undefined {
  if (error instanceof ConflictError && error.code === "WRITE_CONFLICT") {
    return error;
  }
  if (!(error instanceof ConfigGenerationApplyError)) {
    return undefined;
  }
  const applyError = error.cause;
  if (!(applyError instanceof RuntimeOwnerApplyAlreadyRestoredError)) {
    return undefined;
  }
  return applyError.cause instanceof ConflictError && applyError.cause.code === "WRITE_CONFLICT"
    ? applyError.cause
    : undefined;
}

function deepEqualCanonical(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqualCanonical(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => leftRecord[key] !== undefined)
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => rightRecord[key] !== undefined)
    .sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqualCanonical(leftRecord[key], rightRecord[key]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
