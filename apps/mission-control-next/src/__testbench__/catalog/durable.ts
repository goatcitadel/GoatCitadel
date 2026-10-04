import { cancelDurableRun, recoverDurableDeadLetter } from "@goatcitadel/mission-control-shared/api/durable";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { CheckAssertionError, ensure, pass } from "../runner/assert";
import { readErrorMessage } from "../runner/classify";
import type { CheckContext, CheckDef } from "../runner/types";
import { seedDurableRecovery } from "./dev-verification";

/** Statuses that show a recovered run re-entered the queue; it is never still dead-lettered. */
const REQUEUED_STATUSES: readonly string[] = ["queued", "running", "completed"];

/** Seed attempts before giving up on the worker winning the orphan race every time. */
const MAX_ORPHAN_ATTEMPTS = 3;

interface LostRace {
  readonly status: number;
  readonly message: string;
}

/** The Gateway's worker reclaimed the seeded orphan (expired lease) and finished it before the cancel arrived. */
function readLostRace(error: unknown): LostRace | undefined {
  if (!isApiRequestError(error) || error.status !== 409) {
    return undefined;
  }
  const message = readErrorMessage(error.body, error.bodyText);
  return /already terminal/i.test(message) ? { status: error.status, message } : undefined;
}

/**
 * The worker also polls for runs whose lease expired, so it can finish the seeded orphan before the cancel.
 * That is the only error treated as a race: it reseeds, and every other error ends the check.
 */
async function seedAndCancelOrphan(ctx: CheckContext) {
  let lastRace: LostRace | undefined;
  for (let attempt = 1; attempt <= MAX_ORPHAN_ATTEMPTS; attempt += 1) {
    const seed = await seedDurableRecovery(ctx.signal);
    try {
      return { seed, cancelled: await cancelDurableRun(seed.orphanRecovery.runId) };
    } catch (error) {
      lastRace = readLostRace(error);
      if (!lastRace) {
        throw error;
      }
      ctx.log(`Attempt ${attempt}: the worker finished the seeded orphan before it was cancelled; reseeding.`);
    }
  }
  throw new CheckAssertionError(
    `The durable worker reclaimed and completed the seeded orphan before it could be cancelled (${MAX_ORPHAN_ATTEMPTS} attempts).`,
    { attempts: MAX_ORPHAN_ATTEMPTS, ...lastRace },
  );
}

export const durableChecks: readonly CheckDef[] = [
  {
    id: "durable.recovery",
    kind: "journey",
    domain: "durable",
    title: "Durable run recovery controls",
    tier: "mutate",
    description:
      "The seeded orphaned run is cancelled first: once the dead letter is recovered, the Gateway's worker also reclaims any run with an expired lease. If the worker finishes the orphan before the cancel, the check reseeds, up to three attempts.",
    routes: [
      "POST /api/v1/dev/verification/durable-recovery-seed",
      "POST /api/v1/durable/runs/:runId/cancel",
      "POST /api/v1/durable/dead-letters/:entryId/recover",
    ],
    steps: ["Seed and cancel an orphaned run", "Recover the dead-lettered run"],
    async run(ctx) {
      const { seed, cancelled } = await ctx.step("Seed and cancel an orphaned run", () => seedAndCancelOrphan(ctx));
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
