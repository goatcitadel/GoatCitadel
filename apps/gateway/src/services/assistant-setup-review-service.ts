import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  ServiceUnavailableError,
  type AssistantReadinessResponse,
  type AssistantSetupReviewInput,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { EvolutionControlPlaneService } from "./evolution-control-plane-service.js";
export interface AssistantSetupReviewDeps {
  owner?: Pick<EvolutionControlPlaneService, "findByIdempotencyKey" | "get" | "create" | "cancel">;
  readiness: AssistantReadinessResponse;
  refreshReadiness?: () => Promise<AssistantReadinessResponse>;
}
/** Prepare an inactive review. Only this owner's untouched confirmation can be
 * retired automatically; approvals and effects keep their existing lifecycle. */
export async function prepareAssistantSetupReview(
  deps: AssistantSetupReviewDeps,
  input: AssistantSetupReviewInput,
  actorId: string | undefined,
): Promise<ChangePlanRecord> {
  const { readiness, owner } = deps;
  if (!owner) throw new ServiceUnavailableError("Assistant setup reviews are unavailable on this runtime.");
  if (
    !actorId?.trim() ||
    readiness.sessionId !== input.sessionId ||
    readiness.workspaceId !== input.workspaceId ||
    !/^[A-Za-z0-9_-]{16,100}$/u.test(input.operationId)
  )
    throw new ConflictError({
      message: "Sign in and review setup in the current private conversation before continuing.",
    });
  const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
  const marker = `assistant-setup-review:${digest([input.workspaceId, input.sessionId, readiness.sessionIncarnationId ?? null])}:`;
  const actor = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    surface: "chat" as const,
    actorId,
    requestId: `${marker}${input.operationId}`,
  };
  const key = `assistant-setup:${digest([marker, actorId, input.itemId, input.operationId])}`;
  const scoped = (plan: ChangePlanRecord) =>
    plan.origin.workspaceId === input.workspaceId &&
    plan.origin.sessionId === input.sessionId &&
    plan.origin.surface === "chat" &&
    plan.origin.actorId === actorId;
  const blocked = (plan?: ChangePlanRecord) =>
    new ConflictError({
      message:
        "An existing setup review needs attention. Review or cancel its setup card in this conversation before preparing another change.",
      details: {
        reason: "assistant_setup_review_blocked",
        ...(plan ? { resourceKind: "change_plan", resourceId: plan.planId } : {}),
      },
    });
  const replay = await owner.findByIdempotencyKey(actor, key);
  if (replay) {
    if (!scoped(replay) || !replay.origin.requestId?.startsWith(marker)) throw blocked();
    return replay;
  }
  if (input.expectedSourceHash !== readiness.sourceHash)
    throw new ConflictError({
      message: "Setup changed. Refresh readiness and review the current settings before continuing.",
    });
  const action =
    input.itemId === "indexed_recall"
      ? readiness.indexedRecallSetup
      : input.itemId === "skill_use"
        ? readiness.reviewedSkillUseSetup
        : readiness.items.find((item) => item.id === input.itemId)?.nextAction;
  const request = action?.request;
  if (
    action?.kind !== "review_change_plan" ||
    request?.kind !== "runtime_configuration" ||
    !["feature_flag", "feature_flags", "memory_configuration"].includes(request.change.operation)
  )
    throw new ConflictError({ message: "This setup action changed. Refresh readiness and use its current owner." });
  const create = () =>
    owner.create({ actor, request, idempotencyKey: key, expectedTargetRevision: readiness.configRevision });
  try {
    return await create();
  } catch (cause) {
    if (
      !(cause instanceof ConflictError) ||
      cause.details?.resourceKind !== "change_plan" ||
      typeof cause.details.resourceId !== "string"
    )
      throw cause;
    const existing = await owner.get(actor, cause.details.resourceId);
    if (
      !scoped(existing) ||
      canonicalJsonString(existing.request) !== canonicalJsonString(request) ||
      existing.adapter.adapterId !== "runtime-configuration" ||
      existing.adapter.version !== 2 ||
      existing.target.ownerId !== "runtime_settings"
    )
      throw blocked(existing);
    const expired = Boolean(existing.expiresAt && Date.parse(existing.expiresAt) <= Date.now());
    if (existing.target.expectedRevision === readiness.configRevision && !expired) return existing;
    if (
      !readiness.sessionIncarnationId ||
      !existing.origin.requestId?.startsWith(marker) ||
      existing.revision !== 1 ||
      existing.status !== "awaiting_confirmation" ||
      existing.requiredAction?.kind !== "confirmation" ||
      existing.requiredAction.purpose === "rollback" ||
      existing.appliedAt
    )
      throw blocked(existing);
    try {
      await owner.cancel(actor, existing.planId, existing.revision, existing.requiredAction.actionNonce);
    } catch (error) {
      const current = await owner.get(actor, existing.planId);
      if (
        current.status !== "cancelled" ||
        !scoped(current) ||
        current.appliedAt ||
        canonicalJsonString(current.request) !== canonicalJsonString(request)
      )
        throw error;
    }
    if (deps.refreshReadiness) {
      const fresh = await deps.refreshReadiness();
      if (
        fresh.workspaceId !== readiness.workspaceId ||
        fresh.sessionId !== readiness.sessionId ||
        fresh.sessionIncarnationId !== readiness.sessionIncarnationId ||
        fresh.sourceHash !== readiness.sourceHash
      )
        throw new ConflictError({
          message:
            "Setup changed while its outdated review was retired. Refresh readiness before creating the new review.",
        });
    }
    // A competing explicit review can win the target after cancellation. It
    // remains inspectable; a retry converges through the same owner and key.
    return create();
  }
}
