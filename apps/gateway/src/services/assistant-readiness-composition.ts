import { AssistantReadinessService } from "./assistant-readiness-service.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
export function createAssistantReadinessForGateway(
  gateway: Pick<
    GatewayRouteCompositionPort,
    "storage" | "config" | "readFeatureFlags" | "readSettingsRevision" | "chatAssistant"
  >,
) {
  return new AssistantReadinessService({
    setupReviewOwner: gateway.chatAssistant.setupPlans,
    readSession: async (sessionId) => {
      const [meta, session, prefs, flags] = await Promise.all([
        gateway.storage.chatSessionMeta.get(sessionId),
        gateway.storage.sessions.getBySessionId(sessionId),
        gateway.storage.chatSessionPrefs.get(sessionId),
        gateway.readFeatureFlags(),
      ]);
      if (!meta) return undefined;
      return {
        sessionId,
        workspaceId: meta.workspaceId,
        sessionIncarnationId: meta.lifecycleIntentId,
        active: meta.lifecycleStatus === "active",
        privateOperator: session.kind === "dm" && meta.origin === "operator",
        memoryMode: prefs?.memoryMode ?? "auto",
        configRevision: gateway.readSettingsRevision(),
        memoryEnabled: gateway.config.assistant.memory.enabled,
        flags: { ...flags },
      };
    },
    readLearningReadiness: (input) => gateway.chatAssistant.readLearningReadiness(input),
    readFollowThroughReadiness: async () => {
      const flags = await gateway.readFeatureFlags();
      if (flags.autonomyV1Disabled)
        return {
          followUp: { state: "blocked", reasonCode: "autonomy_disabled" },
          scheduledWork: { state: "blocked", reasonCode: "autonomy_disabled" },
        };
      if (!flags.durableKernelV1Enabled)
        return {
          followUp: { state: "disabled", reasonCode: "durable_execution_disabled" },
          scheduledWork: { state: "disabled", reasonCode: "durable_execution_disabled" },
        };
      // Capability readiness does not enroll a session or claim a job is scheduled.
      return {
        followUp: flags.commitmentScheduledTurnsV1Enabled
          ? { state: "ready", reasonCode: "accepted_commitments_only" }
          : { state: "disabled", reasonCode: "commitment_scheduling_disabled" },
        scheduledWork: flags.scheduledChatTurnsV1Enabled
          ? { state: "ready", reasonCode: "explicit_schedule_required" }
          : { state: "disabled", reasonCode: "scheduled_chat_disabled" },
      };
    },
  });
}
