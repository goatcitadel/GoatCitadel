import {
  canonicalJsonString,
  type ExternalConnectorActionSummary,
  type ExternalConnectorServiceSummary,
  type ExternalConnectorReviewStateRecord,
  type ExternalConnectorStageActionResult,
} from "@goatcitadel/contracts";

export interface ExternalConnectorReview {
  service: ExternalConnectorServiceSummary;
  action?: ExternalConnectorActionSummary;
  status: "reviewed" | "hidden" | "staged";
  workspaceId: string;
  isCurrent: () => boolean;
}
export function sameExternalService(a: ExternalConnectorServiceSummary, b: ExternalConnectorServiceSummary) {
  const { actions: _a, ...left } = a,
    { actions: _b, ...right } = b;
  return canonicalJsonString(left) === canonicalJsonString(right);
}
export function externalReviewSummary(state: ExternalConnectorReviewStateRecord) {
  const { status, pinned, note, proposalId, updatedAt } = state;
  return { status, pinned, note, proposalId, updatedAt };
}
export function assertExternalReviewReceipt(
  review: ExternalConnectorReview,
  state: ExternalConnectorReviewStateRecord,
) {
  if (
    state.workspaceId !== review.workspaceId ||
    state.sourceId !== review.service.sourceId ||
    state.serviceId !== review.service.serviceId ||
    state.actionId !== review.action?.actionId ||
    state.status !== review.status ||
    !state.createdAt ||
    !state.updatedAt
  )
    throw new Error("The external connector owner did not acknowledge the reviewed workspace and target.");
}
export function assertExternalReviewReadback(
  review: ExternalConnectorReview,
  target: ExternalConnectorServiceSummary | ExternalConnectorActionSummary,
  state: ExternalConnectorReviewStateRecord,
) {
  const definitionMatches = review.action
    ? canonicalJsonString({ ...target, reviewState: review.action.reviewState }) === canonicalJsonString(review.action)
    : !("actionId" in target) &&
      sameExternalService({ ...target, reviewState: review.service.reviewState }, review.service);
  if (
    !definitionMatches ||
    canonicalJsonString(target.reviewState) !== canonicalJsonString(externalReviewSummary(state))
  )
    throw new Error("The exact external connector target and saved review state could not be confirmed.");
}
export function assertExternalStageReceipt(
  review: ExternalConnectorReview,
  result: ExternalConnectorStageActionResult,
) {
  assertExternalReviewReceipt(review, result.state);
  const action = review.action;
  if (
    !action ||
    result.state.proposalId !== result.proposal.proposalId ||
    !result.state.pinned ||
    result.proposal.proposalKind !== "tool" ||
    !result.proposal.proposalId ||
    result.proposal.payload.sourceKind !== "external_connector_catalog" ||
    result.proposal.payload.sourceId !== action.sourceId ||
    result.proposal.payload.sourceCommit !== review.service.source.commit ||
    result.proposal.payload.callable !== false ||
    result.proposal.payload.runtimePosture !== "catalog_only" ||
    (result.proposal.payload.service as { serviceId?: string } | undefined)?.serviceId !== action.serviceId ||
    (result.proposal.payload.action as { actionId?: string; handlerSha256?: string } | undefined)?.actionId !==
      action.actionId ||
    (result.proposal.payload.action as { handlerSha256?: string } | undefined)?.handlerSha256 !==
      action.handlerSha256 ||
    canonicalJsonString({ ...result.action, reviewState: action.reviewState }) !== canonicalJsonString(action)
  )
    throw new Error(
      "The staged proposal did not confirm the exact reviewed catalog action. Inspect owner evidence before repeating it.",
    );
}
