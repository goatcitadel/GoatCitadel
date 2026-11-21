import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  type ChangePlanRecord,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import { ChatContinuationService } from "./chat-continuation-service.js";
import { withCanonicalApprovalOutcome } from "./approval-canonical-outcome.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import { isKnownExpiredReviewWaitEffect } from "./chat-continuation-wait-evidence.js";

export function createChatContinuationForGateway(
  gateway: Pick<GatewayRouteCompositionPort, "storage" | "readSettingsRevision">,
  plans: GatewayRouteCompositionPort["chatAssistant"]["setupPlans"],
) {
  return new ChatContinuationService({
    readSource: async (input) => {
      const [meta, session] = await Promise.all([
        gateway.storage.chatSessionMeta.get(input.sessionId),
        gateway.storage.sessions.getBySessionId(input.sessionId),
      ]);
      if (
        !meta ||
        meta.workspaceId !== input.workspaceId ||
        meta.lifecycleStatus !== "active" ||
        meta.origin !== "operator" ||
        session.kind !== "dm" ||
        !meta.lifecycleIntentId
      )
        throw new NotFoundError({ entity: "Chat recovery", id: input.approvalId });
      const approval = await withCanonicalApprovalOutcome(
        gateway.storage,
        await gateway.storage.approvals.get(input.approvalId),
      );
      if (
        approval.linkage?.sessionId !== input.sessionId ||
        approval.linkage.workspaceId !== input.workspaceId ||
        (input.sourceTurnId !== undefined && approval.linkage.turnId !== input.sourceTurnId)
      )
        throw new NotFoundError({ entity: "Chat recovery", id: input.approvalId });
      if (input.sourceTurnId) {
        const trace = await gateway.storage.chatTurnTraces.get(input.sourceTurnId);
        if (trace.sessionId !== input.sessionId)
          throw new NotFoundError({ entity: "Chat recovery", id: input.approvalId });
      }
      const [effects, pending, events] = await Promise.all([
        gateway.storage.approvalEffects.listByApproval(input.approvalId),
        gateway.storage.pendingApprovalActions.find(input.approvalId),
        gateway.storage.approvalEvents.listByApprovalId(input.approvalId),
      ]);
      let plan: ChangePlanRecord | undefined;
      let noPlanEffect = false;
      if (approval.kind === "change_plan_effect" && typeof approval.payload.planId === "string") {
        plan = await plans.get(
          { workspaceId: input.workspaceId, sessionId: input.sessionId, surface: "chat", actorId: input.actorId },
          approval.payload.planId,
        );
        if (plan.origin.sessionId !== input.sessionId || plan.origin.actorId !== input.actorId)
          throw new NotFoundError({ entity: "Chat recovery", id: input.approvalId });
        const intentHash = createHash("sha256").update(canonicalJsonString(plan.request)).digest("hex");
        if (
          intentHash !== plan.intentHash ||
          approval.payload.intentHash !== plan.intentHash ||
          approval.payload.targetRevision !== plan.target.expectedRevision ||
          approval.payload.adapterId !== plan.adapter.adapterId ||
          approval.payload.adapterVersion !== plan.adapter.version
        )
          throw new ConflictError({ message: "The expired review no longer matches its exact saved setup request." });
        const history = await gateway.storage.changePlans.listEvents(plan.planId, 501);
        noPlanEffect =
          history.length < 501 &&
          !history.some((event) =>
            ["applying", "verifying", "monitoring", "completed", "rolling_back", "rolled_back"].includes(
              event.toStatus,
            ),
          ) &&
          !plan.appliedAt;
      }
      let waitReservation: { approvalId: string; runId: string } | undefined;
      let waitRun: DurableRunRecord | undefined;
      if (
        plan &&
        noPlanEffect &&
        approval.resolutionOutcome === "expired" &&
        effects.some((effect) => ["approval_wait_materialize", "approval_wait_wake"].includes(effect.effectKind))
      ) {
        const reserved = await gateway.storage.approvalWaitRuns.get(input.approvalId);
        if (reserved?.runId) {
          waitReservation = { approvalId: reserved.approvalId, runId: reserved.runId };
          try {
            waitRun = await gateway.storage.durableRuns.getRun(reserved.runId);
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
          }
        }
      }
      const noExecutedAction =
        !events.some((event) => event.eventType === "approved_action_executed") &&
        effects.every(
          (effect) =>
            [
              "approval_observability",
              "approval_after_hooks",
              "approval_resolution_signals",
              "approval_inbox_follow_up",
            ].includes(effect.effectKind) ||
            effect.status === "skipped" ||
            (plan &&
              noPlanEffect &&
              isKnownExpiredReviewWaitEffect({ approval, effect, reservation: waitReservation, run: waitRun })),
        );
      return {
        workspaceId: meta.workspaceId,
        sessionId: input.sessionId,
        sessionIncarnationId: meta.lifecycleIntentId,
        active: true,
        privateOperator: true,
        approvalId: input.approvalId,
        sourceTurnId: approval.linkage.turnId,
        outcome: approval.resolutionOutcome ?? "unknown",
        effectsKnownNotExecuted:
          noExecutedAction &&
          (plan
            ? noPlanEffect && !pending
            : pending?.resolutionStatus === "rejected" && pending.result?.expired === true),
        plan,
        currentSettingsRevision: gateway.readSettingsRevision(),
      };
    },
    renewPlan: async (input) => {
      const replay = await plans.findReplay(input.actor, input.idempotencyKey!, input.request);
      return replay ?? plans.create(input);
    },
  });
}
