import type { CronJobRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { CronStorageMutation } from "./cron-config-generation-owner.js";
import { normalizeAgentTurnCronActionConfig } from "./gateway/cron-agent-turn-support.js";

/** Called inside the existing configuration-generation transaction. */
export async function bindScheduledCreatorAuthority(
  storage: Pick<AsyncStorage, "cronJobs">,
  mutation: CronStorageMutation,
  result: CronJobRecord | boolean | CronJobRecord[],
) {
  if ((mutation.kind === "create" || mutation.kind === "update") && mutation.creatorAuthority) {
    return storage.cronJobs.bindCreatorAuthority(
      mutation.spec.jobId,
      (result as CronJobRecord).revision,
      mutation.creatorAuthority,
    );
  }
  return result;
}

/** Recovery reads a previously claimed occurrence; it does not admit a new one. */
export async function requireClaimedCommitmentOccurrence(
  host: { storage: Pick<AsyncStorage, "cronRuns"> },
  runId: string,
) {
  const run = await host.storage.cronRuns.get(runId);
  const config = run?.actionSnapshot.actionConfig;
  if (
    !run ||
    run.action !== "agent_turn" ||
    !normalizeAgentTurnCronActionConfig(
      config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {},
    )?.agentTurn?.commitment
  )
    throw new Error("Commitment occurrence must be canonically claimed before processing.");
  return run;
}
