import { createHash } from "node:crypto";
import { canonicalJsonString, NotFoundError } from "@goatcitadel/contracts";
import { DEFAULT_SESSION_AUTONOMY_PREFS } from "@goatcitadel/storage";
import { permissionProfileAppliesToCreator } from "./gateway/scheduled-profile-intersection.js";
import { FollowThroughSetupService } from "./follow-through-setup-service.js";
import { resolveFollowThroughDestination } from "./follow-through-schedule-input.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
export function createFollowThroughSetupForGateway(
  gateway: Pick<
    GatewayRouteCompositionPort,
    "storage" | "config" | "readFeatureFlags" | "readSettingsRevision" | "cronAutomationService"
  >,
) {
  return new FollowThroughSetupService({
    readSource: async (input) => {
      const [meta, session, flags, profiles, hooks, prefs, autonomy, connections] = await Promise.all([
        gateway.storage.chatSessionMeta.get(input.sessionId),
        gateway.storage.sessions.getBySessionId(input.sessionId),
        gateway.readFeatureFlags(),
        gateway.storage.permissionProfiles.listProfiles(),
        gateway.storage.workspaceHooks.listByTrigger(input.workspaceId, "subagent.end", 50),
        gateway.storage.chatSessionPrefs.get(input.sessionId),
        gateway.storage.sessionAutonomyPrefs.get(input.sessionId),
        gateway.storage.integrationConnections.list("channel"),
      ]);
      if (!meta || meta.workspaceId !== input.workspaceId)
        throw new NotFoundError({ entity: "Chat schedule setup", id: input.sessionId });
      const workspace = await gateway.storage.workspaces.get(meta.workspaceId),
        citadel = workspace.citadelId ? await gateway.storage.citadels.findRecord(workspace.citadelId) : undefined;
      const charter =
        workspace.citadelId && !citadel ? await gateway.storage.citadels.getCitadel(workspace.citadelId) : undefined;
      const { dailyUsdHardCap, sessionTokenHardCap } = gateway.config.assistant.budgets;
      const limits = {
        scope: "installation" as const,
        dailyUsdHardCap,
        sessionTokenHardCap,
      };
      const activeHours = autonomy?.activeHours ?? DEFAULT_SESSION_AUTONOMY_PREFS.activeHours;
      return {
        workspaceId: meta.workspaceId,
        sessionId: input.sessionId,
        sessionIncarnationId: meta.lifecycleIntentId ?? "",
        conversationContextHash: hash({ prefs: prefs ?? null, activeHours }),
        quietHours: {
          start: activeHours.start,
          end: activeHours.end,
          timezone: activeHours.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        active: meta.lifecycleStatus === "active" && workspace.lifecycleStatus === "active",
        privateOperator: meta.origin === "operator" && session.kind === "dm",
        citadelId: citadel?.lifecycleStatus === "active" || (!citadel && charter) ? workspace.citadelId : undefined,
        configRevision: gateway.readSettingsRevision(),
        enabled:
          !flags.autonomyV1Disabled &&
          flags.durableKernelV1Enabled === true &&
          flags.scheduledChatTurnsV1Enabled === true,
        profiles: profiles
          .filter(
            (profile) =>
              profile.status === "active" &&
              permissionProfileAppliesToCreator({
                profile,
                creatorActorId: input.actorId,
                workspaceId: meta.workspaceId,
              }),
          )
          .map((profile) => ({
            profileId: profile.profileId,
            revision: profile.revision,
            label: profile.label,
            description: profile.description ?? "",
            approvalMode: profile.approvalMode,
          })),
        eventSources: hooks
          .filter((hook) => hook.enabled && hook.mode === "observe" && hook.trigger === "subagent.end")
          .map((hook) => ({
            hookId: hook.hookId,
            label: hook.label,
            sourceHash: hash({
              hookId: hook.hookId,
              updatedAt: hook.updatedAt,
              trigger: hook.trigger,
              mode: hook.mode,
              enabled: hook.enabled,
            }),
          })),
        channelDestinations: connections.flatMap((connection) => {
          const destination = resolveFollowThroughDestination(connection, meta.workspaceId);
          return destination ? [destination] : [];
        }),
        limits,
        blockedReasons:
          limits.dailyUsdHardCap > 0 && limits.sessionTokenHardCap > 0
            ? []
            : ["The installation has no available cost/token allowance. Review its budgets before scheduling work."],
      };
    },
    getJob: (id) => gateway.storage.cronJobs.get(id),
    createJob: (input, actor) => gateway.cronAutomationService.createCronJob(input, actor),
  });
}
