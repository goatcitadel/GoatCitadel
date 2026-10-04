import { cancelDurableRun, recoverDurableDeadLetter } from "@goatcitadel/mission-control-shared/api/durable";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { seedDurableRecovery } from "./dev-verification";

/** Statuses that show a recovered run re-entered the queue; it is never still dead-lettered. */
const REQUEUED_STATUSES: readonly string[] = ["queued", "running", "completed"];

export const durableChecks: readonly CheckDef[] = [
  {
    id: "durable.recovery",
    kind: "journey",
    domain: "durable",
    title: "Durable run recovery controls",
    tier: "mutate",
    description:
      "The seeded orphaned run is cancelled first: once the dead letter is recovered, the Gateway's worker also reclaims any run with an expired lease.",
    routes: [
      "POST /api/v1/dev/verification/durable-recovery-seed",
      "POST /api/v1/durable/runs/:runId/cancel",
      "POST /api/v1/durable/dead-letters/:entryId/recover",
    ],
    steps: ["Seed recovery runs", "Cancel the orphaned run", "Recover the dead-lettered run"],
    async run(ctx) {
      const seed = await ctx.step("Seed recovery runs", () => seedDurableRecovery(ctx.signal));
      const cancelled = await ctx.step("Cancel the orphaned run", () => cancelDurableRun(seed.orphanRecovery.runId));
      ensure(cancelled.status === "cancelled", `The orphaned run is ${cancelled.status}, not cancelled.`, cancelled);
      // The retry route only accepts failed runs; a dead-lettered run is recovered through its dead-letter entry.
      const recovered = await ctx.step("Recover the dead-lettered run", () =>
        recoverDurableDeadLetter(seed.deadLetterRecovery.deadLetterId),
      );
      ensure(
        REQUEUED_STATUSES.includes(recovered.status),
        `The dead-lettered run is ${recovered.status} instead of back in the queue.`,
        recovered,
      );
      return pass(`The recovered run is ${recovered.status}; the orphaned run is cancelled.`);
    },
  },
];
