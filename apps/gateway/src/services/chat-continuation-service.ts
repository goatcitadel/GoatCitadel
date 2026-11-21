import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  type ChangePlanRecord,
  type ChatContinuationInput,
  type PreparedChatContinuation,
} from "@goatcitadel/contracts";
import type { EvolutionControlPlaneCreateInput } from "./evolution-control-plane-service.js";

export interface ChatContinuationSource {
  workspaceId: string;
  sessionId: string;
  sessionIncarnationId: string;
  active: boolean;
  privateOperator: boolean;
  approvalId: string;
  sourceTurnId?: string;
  outcome: string;
  effectsKnownNotExecuted: boolean;
  plan?: ChangePlanRecord;
  currentSettingsRevision: number;
}
type ActorInput = ChatContinuationInput & { actorId: string };
export interface ChatContinuationDeps {
  readSource(input: ActorInput): Promise<ChatContinuationSource>;
  renewPlan(input: EvolutionControlPlaneCreateInput): Promise<ChangePlanRecord>;
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
export class ChatContinuationService {
  public constructor(private readonly deps: ChatContinuationDeps) {}
  public async inspect(input: ActorInput): Promise<PreparedChatContinuation> {
    return this.project(input, await this.source(input));
  }
  public async prepare(input: ActorInput & { expectedSourceHash: string }): Promise<PreparedChatContinuation> {
    const source = await this.source(input),
      review = this.project(input, source);
    if (review.sourceHash !== input.expectedSourceHash || review.status !== "review_required" || !source.plan)
      throw new ConflictError({
        message:
          review.sourceHash !== input.expectedSourceHash
            ? "The request, policy or conversation changed. Refresh this recovery before deciding."
            : review.reason,
      });
    // Only the existing owner creates/claims this target. Its idempotency key is
    // stable across tabs and retries, and its adapter revalidates current policy.
    const plan = await this.deps.renewPlan({
      actor: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        surface: "chat",
        ...(input.sourceTurnId ? { turnId: input.sourceTurnId } : {}),
      },
      request: source.plan.request,
      expectedTargetRevision: source.plan.target.expectedRevision,
      idempotencyKey: `chat-renewal:${hash({ approvalId: input.approvalId, sourceHash: review.sourceHash, actorId: input.actorId })}`,
    });
    if (
      plan.origin.workspaceId !== input.workspaceId ||
      plan.origin.sessionId !== input.sessionId ||
      plan.origin.actorId !== input.actorId ||
      canonicalJsonString(plan.request) !== canonicalJsonString(source.plan.request)
    )
      throw new ConflictError({
        message: "The recovery owner returned different reviewed material. Inspect the saved plan before continuing.",
      });
    return {
      ...review,
      plan,
      approvalId: plan.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId : undefined,
      reason:
        "Review the same setup request against current policy. Applying it does not replay the old Chat turn or grant tool access.",
      nextAction: {
        kind: "inspect_owner",
        label: "Review current setup",
        href: `/inbox?item=${encodeURIComponent(`change_plan:${plan.planId}`)}&workspaceId=${encodeURIComponent(input.workspaceId)}`,
      },
    };
  }
  private async source(input: ActorInput) {
    const source = await this.deps.readSource(input);
    if (
      !source.active ||
      !source.privateOperator ||
      source.workspaceId !== input.workspaceId ||
      source.sessionId !== input.sessionId ||
      source.approvalId !== input.approvalId ||
      (input.sourceTurnId !== undefined && source.sourceTurnId !== input.sourceTurnId)
    )
      throw new NotFoundError({ entity: "Chat recovery", id: input.approvalId });
    return source;
  }
  private project(input: ActorInput, source: ChatContinuationSource): PreparedChatContinuation {
    const sourceHash = hash({ version: 1, ...source, actorId: input.actorId, reason: input.reason }),
      base = {
        version: 1 as const,
        continuationId: `chat-recovery:${sourceHash}`,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sourceHash,
      };
    if (!source.effectsKnownNotExecuted)
      return {
        ...base,
        status: "unknown_effect",
        reason:
          "Execution could not be proved absent. Inspect the persisted approval and effect; this action will not be resent.",
        nextAction: {
          kind: "inspect_owner",
          label: "Inspect execution outcome",
          href: `/inbox?approvalId=${encodeURIComponent(input.approvalId)}`,
        },
      };
    const plan = source.plan;
    const supported =
      plan?.kind === "runtime_configuration" &&
      plan.request.kind === "runtime_configuration" &&
      ["feature_flag", "feature_flags", "memory_configuration"].includes(plan.request.change.operation) &&
      plan.target.ownerId === "runtime_settings" &&
      plan.adapter.adapterId === "runtime-configuration" &&
      plan.adapter.version === 2 &&
      plan.origin.workspaceId === input.workspaceId &&
      plan.origin.sessionId === input.sessionId &&
      plan.origin.actorId === input.actorId &&
      plan.target.expectedRevision === source.currentSettingsRevision &&
      plan.status === "failed" &&
      ["approval_expired", "expired"].includes(plan.result?.failureCode ?? "") &&
      plan.approvalRefs.includes(input.approvalId);
    if (input.reason !== "approval_expired" || source.outcome !== "expired" || !supported)
      return {
        ...base,
        status: "blocked",
        reason:
          source.outcome !== "expired"
            ? "Only a canonically expired review can be renewed here. A denial is not renewable."
            : "This owner has no verified renewal for the current request and policy. Ask again to prepare fresh work; your draft is preserved.",
        nextAction: { kind: "ask_again", label: "Ask again" },
      };
    return {
      ...base,
      status: "review_required",
      reason:
        "This setup review expired before applying. You can review the exact saved request again without rerunning model planning.",
      nextAction: { kind: "review_again", label: "Review again" },
    };
  }
}
