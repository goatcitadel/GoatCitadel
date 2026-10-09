import type { ChangePlanRecord, ChannelPlanReviewHandoff } from "@goatcitadel/contracts";
export function createChannelPlanReviewHandoff(plan: ChangePlanRecord): ChannelPlanReviewHandoff {
  if (plan.request.kind !== "channel_connection" || !plan.request.draftId || plan.origin.sessionId ||
      plan.origin.surface !== "settings" || plan.target.ownerId !== "channel_setup_draft" ||
      plan.target.resourceId !== plan.request.draftId) {
    throw new Error("This is not a workspace channel setup plan.");
  }
  const handoff = { workspaceId: plan.origin.workspaceId, planId: plan.planId, reviewedRevision: plan.revision, draftId: plan.request.draftId };
  if (!validHandoff(handoff)) throw new Error("The channel setup plan has invalid navigation identifiers.");
  return handoff;
}
export function channelPlanReviewRouteFields(handoff: ChannelPlanReviewHandoff) {
  if (!validHandoff(handoff)) throw new Error("Invalid channel plan handoff.");
  return { channelPlan: handoff.planId, channelDraft: handoff.draftId, channelRevision: handoff.reviewedRevision, channelWorkspace: handoff.workspaceId };
}
export function channelPlanReviewSearch(handoff: ChannelPlanReviewHandoff): string {
  const fields = channelPlanReviewRouteFields(handoff);
  return "?" + new URLSearchParams({ ...fields, channelRevision: String(fields.channelRevision) });
}
export function channelPlanReviewHref(handoff: ChannelPlanReviewHandoff): string {
  return "/chat" + channelPlanReviewSearch(handoff);
}
export function readChannelPlanReviewHandoff(search: string): ChannelPlanReviewHandoff | null {
  const params = new URLSearchParams(search);
  const keys = ["channelPlan", "channelDraft", "channelRevision", "channelWorkspace"];
  if (keys.some((key) => params.getAll(key).length !== 1)) return null;
  const revision = params.get("channelRevision") ?? "";
  if (!/^[1-9][0-9]*$/.test(revision)) return null;
  const handoff = { workspaceId: params.get("channelWorkspace") ?? "", planId: params.get("channelPlan") ?? "",
    reviewedRevision: Number(revision), draftId: params.get("channelDraft") ?? "" };
  return validHandoff(handoff) ? handoff : null;
}
export function assertChannelPlanReviewBinding(plan: ChangePlanRecord, handoff: ChannelPlanReviewHandoff): void {
  const canonical = createChannelPlanReviewHandoff(plan);
  if (canonical.workspaceId !== handoff.workspaceId || canonical.planId !== handoff.planId || canonical.draftId !== handoff.draftId) {
    throw new Error("This plan does not match the requested workspace and channel draft.");
  }
}
/** Return destinations are derived exclusively from the canonical channel plan. */
export function channelPlanReturnHref(plan: ChangePlanRecord): string {
  const handoff = createChannelPlanReviewHandoff(plan);
  const params = new URLSearchParams({ channelPlan: handoff.planId, channelDraft: handoff.draftId, channelWorkspace: handoff.workspaceId });
  const connection = plan.evidenceRefs.find((ref) => ref.startsWith("channel-connection:"))?.slice("channel-connection:".length);
  if (connection && validNavigationId(connection)) params.set("channelConnection", connection);
  return "/settings/channels?" + params;
}
export function validNavigationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
}
function validHandoff(handoff: ChannelPlanReviewHandoff): boolean {
  return validNavigationId(handoff.workspaceId) && validNavigationId(handoff.planId) && validNavigationId(handoff.draftId) &&
    Number.isSafeInteger(handoff.reviewedRevision) && handoff.reviewedRevision > 0;
}
/** Preserve a valid workspace handoff while Chat publishes a canonical session selection. */
export function preserveChannelPlanReviewHref(destination: string, search: string, workspaceId: string): string {
  const handoff = readChannelPlanReviewHandoff(search);
  if (!handoff || handoff.workspaceId !== workspaceId) return destination;
  const url = new URL(destination, "http://goatcitadel.local");
  if (url.origin !== "http://goatcitadel.local" || url.pathname !== "/chat") throw new Error("Channel review selection stays in Chat.");
  for (const [key, value] of new URLSearchParams(channelPlanReviewSearch(handoff))) url.searchParams.set(key, value);
  return url.pathname + url.search + url.hash;
}