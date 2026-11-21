import type { DurableRunRecord } from "@goatcitadel/contracts";
import type { BackgroundLearningQueueService } from "./background-learning-queue-service.js";
import type { DurableWorkflowExecutionContext, DurableWorkflowExecutor } from "./durable-execution-service.js";

interface DurableLearningReviewWorkflowDeps {
  queue: Pick<BackgroundLearningQueueService, "process" | "isReadyToClaim" | "releaseForRetry">;
  complete(run: DurableRunRecord, result: Record<string, unknown>): Promise<unknown>;
  assertActive(context?: DurableWorkflowExecutionContext): void;
}

export function createDurableLearningReviewWorkflowExecutor(
  deps: DurableLearningReviewWorkflowDeps,
): DurableWorkflowExecutor {
  return {
    isReadyToClaim: (run) => deps.queue.isReadyToClaim(run),
    execute: async (run, context) => {
      deps.assertActive(context);
      const result = await deps.queue.process(run, context?.signal);
      if (result.disposition !== "complete") {
        await deps.queue.releaseForRetry(run, result);
        return;
      }
      await deps.complete(run, {
        ...result,
        workflow: "learning.review",
        authority: "system_proposal_only",
      });
    },
    isRecoverable: (run) => ({
      recoverable: run.payload.version === "learning.review.v1" && typeof run.payload.jobId === "string",
    }),
  };
}
