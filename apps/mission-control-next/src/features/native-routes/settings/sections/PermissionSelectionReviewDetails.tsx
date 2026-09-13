import type { PermissionProfileSelectionReview } from "@goatcitadel/contracts";
import { SettingsActionList } from "../SettingsShared";
import { describeToolApprovalMode } from "../../SettingsNativePage";
import { describeReadAccessMode, formatPermissionContextLabel } from "./PermissionProfileDraftFields";

export function PermissionSelectionReviewDetails({ review }: { review: PermissionProfileSelectionReview }) {
  const contexts = review.input.operation === "activate" ? [review.input.surface ?? "all"] : review.input.defaultForSurfaces;
  return <section aria-label="Reviewed permission selection">
    <p><strong>Reviewed selection</strong>: {contexts.length ? contexts.map(formatPermissionContextLabel).join(", ") : "Remove this profile's automatic defaults"}.</p>
    <p>Applies to {review.target.workspaceId ? `workspace ${review.target.workspaceId}` : `operator ${review.target.operatorId}`}{review.target.sessionId ? `, session ${review.target.sessionId}` : ""}.</p>
    {review.profile ? <SettingsActionList ariaLabel="Reviewed profile rules" items={[
      { label: review.input.operation === "defaults" ? `Currently saved: ${review.profile.label}` : review.profile.label,
        description: describeToolApprovalMode(review.profile.approvalMode) },
      { label: "Filesystem reads", description: describeReadAccessMode(review.profile.readAccessMode ?? "") },
      ...(review.profile.legacyToolProfile ? [{ label: "Legacy tool profile", description: review.profile.legacyToolProfile }] : []),
      { label: "Tool patterns", description: review.profile.toolPatterns.join(", ") || "No tool patterns" },
      { label: "Allow patterns", description: review.profile.allow.join(", ") || "No extra allow patterns" },
      { label: "Deny patterns", description: review.profile.deny.join(", ") || "No profile deny patterns" },
    ]} /> : null}
    <SettingsActionList ariaLabel="Current selections in reviewed scope"
      items={review.activeProfiles.map(({ activation, profile }) => ({ id: activation.activationId,
        label: `${formatPermissionContextLabel(activation.surface ?? "all")}: ${profile.label}`,
        description: describeToolApprovalMode(profile.approvalMode) }))}
      emptyLabel="No explicit selections in this scope. Inherited policy remains applicable." />
    <p>Hard denies, approvals, scoped grants, auth and path boundaries still apply.</p>
  </section>;
}
