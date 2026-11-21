import type { Citadel, CitadelRecord, CronJobRecord } from "@goatcitadel/contracts";
import { NotFoundError, PolicyViolationError, ValidationError } from "@goatcitadel/contracts";

/** The two citadel reads cron scoping needs (the storage citadel repository satisfies it). */
export interface CronCitadelReader {
  findRecord(citadelId: string): CitadelRecord | undefined | Promise<CitadelRecord | undefined>;
  getCitadel(citadelId: string): Citadel | undefined | Promise<Citadel | undefined>;
}

/** Server-resolved execution scope for one cron job. Empty for global (unscoped) jobs. */
export interface CronCitadelExecutionScope {
  citadelId?: string;
  /** The citadel's default workspace. Explicit Chat specs additionally verify their selected workspace in this citadel. */
  workspaceId?: string;
}

const MAX_CITADEL_ID_LENGTH = 200;

type CitadelState = { status: "active"; record?: CitadelRecord } | { status: "archived" } | { status: "missing" };

async function readCitadelState(reader: CronCitadelReader, citadelId: string): Promise<CitadelState> {
  const record = await reader.findRecord(citadelId);
  if (record) {
    return record.lifecycleStatus === "archived" ? { status: "archived" } : { status: "active", record };
  }
  // Charter-only citadels (no profile record) are what citadel-scoped listing accepts too.
  return (await reader.getCitadel(citadelId)) ? { status: "active" } : { status: "missing" };
}

/**
 * Normalizes the `citadelId` a create/update request assigns. Blank or null clears the
 * scope (a global job); otherwise the citadel must exist and be active.
 */
export async function normalizeCronJobCitadelId(
  reader: CronCitadelReader,
  value: string | null | undefined,
): Promise<string | undefined> {
  const citadelId = value?.trim();
  if (!citadelId) {
    return undefined;
  }
  if (citadelId.length > MAX_CITADEL_ID_LENGTH) {
    throw new ValidationError({ field: "citadelId", message: "citadelId is too long." });
  }
  const state = await readCitadelState(reader, citadelId);
  if (state.status === "missing") {
    throw new NotFoundError(`Citadel ${citadelId} not found.`);
  }
  if (state.status === "archived") {
    throw new ValidationError({
      field: "citadelId",
      message: `Citadel ${citadelId} is archived; restore it before scheduling work in it.`,
    });
  }
  return citadelId;
}

const DEFAULT_TASK_WORKSPACE_ID = "default";

/** The workspace a Task schedule files its task in: its citadel's default workspace, else the installation default. */
export function cronTaskDestinationWorkspaceId(scope: CronCitadelExecutionScope): string {
  return scope.workspaceId ?? DEFAULT_TASK_WORKSPACE_ID;
}

/**
 * Resolves the scope a due or manual run executes in. A citadel-scoped job whose citadel
 * is gone or archived fails closed (even when forced) instead of running as a global job.
 */
export async function resolveCronJobCitadelScope(
  reader: CronCitadelReader,
  job: Pick<CronJobRecord, "jobId" | "citadelId">,
): Promise<CronCitadelExecutionScope> {
  const citadelId = job.citadelId?.trim();
  if (!citadelId) {
    return {};
  }
  const state = await readCitadelState(reader, citadelId);
  if (state.status !== "active") {
    throw new PolicyViolationError({
      message: `Cron job ${job.jobId} is scoped to citadel ${citadelId}, which is ${
        state.status === "archived" ? "archived" : "no longer present"
      }; the run was refused.`,
    });
  }
  const workspaceId = state.record?.defaultWorkspaceId?.trim();
  return { citadelId, ...(workspaceId ? { workspaceId } : {}) };
}
