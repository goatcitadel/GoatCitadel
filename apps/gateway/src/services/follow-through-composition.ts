import { FollowThroughProjectionService } from "./follow-through-projection-service.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import { ConflictError } from "@goatcitadel/contracts";
import { StarterHeartbeat } from "./starter-heartbeat.js";
export function createFollowThroughForGateway(
  gateway: Pick<
    GatewayRouteCompositionPort,
    "storage" | "readFeatureFlags" | "cronAutomationService" | "chatProactiveService" | "chatTurnRuntime" | "llmService"
  >,
) {
  const storage = gateway.storage;
  // The same model reader as the Gateway's own instance, so a hold recorded
  // after a pricing refusal is recognized here too.
  const heartbeat = new StarterHeartbeat(storage, () => gateway.llmService.getRuntimeConfig({ useCache: true }));
  return new FollowThroughProjectionService({
    storage,
    cron: gateway.cronAutomationService,
    readFlags: async () => ({ ...(await gateway.readFeatureFlags()) }),
    readHeartbeatStatus: async (sessionId) =>
      !(await heartbeat.isArmed(sessionId))
        ? "off"
        : (await heartbeat.isWaitingForPricedModel(sessionId))
          ? "waiting_for_priced_model"
          : "armed",
    updateHeartbeat: async ({ sessionId, expectedRevision, enabled, heartbeatIntervalSeconds }) => {
      await gateway.storage.runImmediateTransaction(async () => {
        const heartbeatEnabled = enabled ?? (await heartbeat.isArmed(sessionId));
        await gateway.storage.sessionAutonomyPrefs.patchWithRevision(
          sessionId,
          { heartbeatEnabled, heartbeatIntervalSeconds },
          expectedRevision,
        );
        await heartbeat.captureExplicitChoice(sessionId, heartbeatEnabled);
      });
    },
    readProactiveRuns: (sessionId, limit) =>
      gateway.chatProactiveService.listChatSessionProactiveRuns(sessionId, limit),
    cancelCurrentRun: async (input) => {
      const [job, run] = await Promise.all([
        gateway.storage.cronJobs.get(input.jobId),
        gateway.storage.cronRuns.get(input.runId),
      ]);
      if (
        !job ||
        job.revision !== input.expectedRevision ||
        job.activeRunId !== input.runId ||
        job.actionConfig?.agentTurn?.sessionId !== input.sessionId ||
        !run ||
        run.jobId !== job.jobId ||
        run.phase !== "chat_execution" ||
        !["admitted", "running", "waiting"].includes(run.status) ||
        !run.childSessionId ||
        !run.childTurnId ||
        run.deliveryRunId ||
        run.externalSideEffectRunId
      )
        throw new ConflictError({
          message: "This occurrence changed or reached delivery. Inspect its current owner before stopping work.",
        });
      const [meta, trace] = await Promise.all([
        gateway.storage.chatSessionMeta.get(run.childSessionId),
        gateway.storage.chatTurnTraces.get(run.childTurnId),
      ]);
      if (meta?.workspaceId !== input.workspaceId || trace.sessionId !== run.childSessionId)
        throw new ConflictError({ message: "The occurrence's Chat scope changed. Inspect its owner." });
      await gateway.chatTurnRuntime.cancelChatTurn(run.childSessionId, run.childTurnId, input.actorId);
    },
  });
}
