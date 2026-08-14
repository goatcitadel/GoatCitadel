import {
  NotFoundError,
  type ChatChangePlanCreateInput,
  type ChatChangePlanRecord,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { EvolutionControlPlaneActor, EvolutionControlPlaneService } from "./evolution-control-plane-service.js";

export interface ChatChangePlanCompatibilityServiceDependencies {
  readonly controlPlane: Pick<EvolutionControlPlaneService, "create" | "list" | "confirmLegacy" | "cancel">;
  readonly resolveActor: (sessionId: string, actorId?: string) => Promise<EvolutionControlPlaneActor>;
}

/**
 * One-release projection for the original session-scoped Chat endpoints.
 * It owns no adapters or mutation logic: every operation re-enters the one
 * singleton Evolution Control Plane and only translates the response shape.
 */
export class ChatChangePlanCompatibilityService {
  public constructor(private readonly deps: ChatChangePlanCompatibilityServiceDependencies) {}

  public async create(
    sessionId: string,
    input: Omit<ChatChangePlanCreateInput, "sessionId">,
  ): Promise<ChatChangePlanRecord> {
    const actor = await this.deps.resolveActor(sessionId, input.requesterActorId);
    const plan = await this.deps.controlPlane.create({
      actor,
      request: input.request,
      ...(actor.requestId ? { idempotencyKey: actor.requestId } : {}),
    });
    return projectChatPlan(plan, sessionId);
  }

  public async list(sessionId: string, limit?: number): Promise<ChatChangePlanRecord[]> {
    const actor = await this.deps.resolveActor(sessionId);
    const plans = await this.deps.controlPlane.list(actor, {
      sessionId,
      ...(limit ? { limit } : {}),
    });
    return plans.map((plan) => projectChatPlan(plan, sessionId));
  }

  public async confirm(sessionId: string, planId: string, expectedRevision: number): Promise<ChatChangePlanRecord> {
    const actor = await this.deps.resolveActor(sessionId);
    const plan = await this.deps.controlPlane.confirmLegacy(actor, planId, expectedRevision);
    return projectChatPlan(plan, sessionId);
  }

  public async cancel(sessionId: string, planId: string, expectedRevision: number): Promise<ChatChangePlanRecord> {
    const actor = await this.deps.resolveActor(sessionId);
    const plan = await this.deps.controlPlane.cancel(actor, planId, expectedRevision);
    return projectChatPlan(plan, sessionId);
  }
}

export function projectChatPlan(plan: ChangePlanRecord, expectedSessionId: string): ChatChangePlanRecord {
  const sessionId = plan.origin.sessionId ?? plan.sessionId;
  if (!sessionId || sessionId !== expectedSessionId) {
    throw new NotFoundError({ entity: "Chat Change Plan", id: plan.planId });
  }
  const compatibilityStatus = plan.status === "completed" ? "applied" : plan.status;
  return {
    ...plan,
    status: compatibilityStatus,
    sessionId,
    ...(plan.origin.actorId || plan.requesterActorId
      ? { requesterActorId: plan.origin.actorId ?? plan.requesterActorId }
      : {}),
    expiresAt: plan.expiresAt ?? compatibilityExpiry(plan.createdAt),
  };
}

function compatibilityExpiry(createdAt: string): string {
  const created = Date.parse(createdAt);
  return new Date((Number.isFinite(created) ? created : 0) + 15 * 60_000).toISOString();
}
