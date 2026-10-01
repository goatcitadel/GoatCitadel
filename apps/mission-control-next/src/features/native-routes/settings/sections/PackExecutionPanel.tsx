import type { CapabilityPackManifest, ChangePlanRecord } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeButton } from "../../primitives";
import type { SettingsSectionProps } from "../SettingsShared";
import { usePackExecution } from "./use-pack-execution";
import { usePackPlanAction, PACK_ACTION_LABELS } from "./use-pack-plan-action";
import { PACK_SETUP_WARNING, packActionDescription, packChildItem, packInboxUrl } from "./pack-plan-presentation";
import { CockpitOwnerLink } from "@next/app/CockpitOwnerLink";
import "./PackExecutionPanel.css";

export function PackExecutionPanel({
  manifest,
  workspaceId,
  navigate,
  route,
}: {
  manifest: CapabilityPackManifest;
  workspaceId: string;
  navigate: SettingsSectionProps["navigate"];
  route: SettingsSectionProps["route"];
}) {
  const owner = usePackExecution(manifest, workspaceId);
  const selected = owner.draft.value;
  return (
    <section aria-label="Pack execution" className="mc-next-pack-execution">
      <p>{PACK_SETUP_WARNING}</p>
      <p>Choose up to 32 bound assets. Some configured resources are shared across the installation.</p>
      {owner.draft.hasRemoteChanges ? (
        <p role="alert">
          This manifest changed while the selection was retained.{" "}
          <NativeButton onClick={owner.draft.discard}>Use current manifest</NativeButton>
        </p>
      ) : null}
      {manifest.assets.slice(0, 100).map((asset) => (
        <label key={asset.id} className="mc-next-settings-checkbox mc-next-pack-asset">
          <input
            type="checkbox"
            checked={selected.includes(asset.id)}
            disabled={
              !asset.binding ||
              owner.attempt.phase !== "idle" ||
              owner.draft.hasRemoteChanges ||
              (!selected.includes(asset.id) && selected.length >= 32)
            }
            onChange={(event) =>
              owner.setSelected(
                event.target.checked ? [...selected, asset.id] : selected.filter((id) => id !== asset.id),
              )
            }
          />
          {asset.label}
          {!asset.binding ? " — execution unavailable" : ""}
        </label>
      ))}
      {manifest.assets.length > 100 ? (
        <p>Only the first 100 assets are shown. Setup accepts at most 32 bound assets.</p>
      ) : null}
      <NativeButton disabled={!owner.ready} onClick={owner.reviewSetup}>
        Review setup plan
      </NativeButton>
      <NativeButton
        variant="secondary"
        disabled={owner.loading || owner.attempt.phase === "pending"}
        onClick={() => void owner.refresh()}
      >
        Refresh setup records
      </NativeButton>
      {owner.loading ? <p role="status">Reading setup records…</p> : null}
      {owner.error ? <p role="alert">{owner.error}</p> : null}
      {owner.attempt.message ? <p role="alert">{owner.attempt.message}</p> : null}
      <p>
        Partial history: at most 20 matching plans from the latest 200 workspace records and 64 explicitly linked
        children. Refresh only reads; owner verification is a separate reviewed action.
      </p>
      {owner.parents.map((plan) => (
        <ClassicPackPlan
          key={plan.planId}
          plan={plan}
          workspaceId={workspaceId}
          onUpdated={() => void owner.refresh()}
          onApproval={(approvalId) => navigate({ area: "ops", section: "approvals", approvalId, theme: route.theme })}
        />
      ))}
      {owner.children.map((child) => (
        <article key={child.planId}>
          <h4>{child.title}</h4>
          <p>
            {child.status.replaceAll("_", " ")} · {child.summary}
          </p>
          <code>{child.planId}</code>
          <p>
            Specialized review remains with the canonical owner. Linked item:{" "}
            <code>{packChildItem(child) ?? "Exact handoff unavailable"}</code>
          </p>
          {packChildItem(child) ? (
            <CockpitOwnerLink
              href={`${packInboxUrl(packChildItem(child)!, workspaceId)}&shell=cockpit`}
              scope={workspaceId}
              label="Inspect linked owner in Inbox"
            />
          ) : null}
          <NativeButton
            variant="secondary"
            onClick={() => navigate({ area: "library", section: "capabilities", theme: route.theme })}
          >
            Open capability library
          </NativeButton>
        </article>
      ))}
      <ConfirmModal
        open={Boolean(owner.review)}
        title="Create reviewed setup plan"
        message={`${PACK_SETUP_WARNING} Selected: ${owner.review?.selected.map((id) => manifest.assets.find((asset) => asset.id === id)?.label).join(", ") ?? ""}. Manifest: ${manifest.provenance.contentHash ?? "unavailable"}.`}
        confirmLabel="Create reviewed setup plan"
        cancelLabel="Cancel setup review"
        pending={owner.attempt.phase === "pending"}
        confirmDisabled={owner.attempt.phase !== "idle"}
        onConfirm={() => void owner.confirmSetup()}
        onCancel={owner.cancelReview}
      />
    </section>
  );
}
function ClassicPackPlan({
  plan,
  workspaceId,
  onUpdated,
  onApproval,
}: {
  plan: ChangePlanRecord;
  workspaceId: string;
  onUpdated: () => void;
  onApproval: (id: string) => void;
}) {
  const owner = usePackPlanAction(plan, workspaceId, onUpdated),
    required = plan.requiredAction;
  return (
    <article>
      <h4>{plan.title}</h4>
      <p>
        {plan.status.replaceAll("_", " ")} · revision {plan.revision}
      </p>
      <p>{plan.summary}</p>
      <p>{plan.impact}</p>
      {plan.result ? <p>{plan.result.summary}</p> : null}
      <code>{plan.planId}</code>
      <div>
        {owner.actions.map((action) => (
          <NativeButton key={action} disabled={owner.attempt.phase !== "idle"} onClick={() => owner.request(action)}>
            {PACK_ACTION_LABELS[action]}
          </NativeButton>
        ))}
        {required?.kind === "approval" && required.approvalId && plan.approvalRefs.includes(required.approvalId) ? (
          <NativeButton variant="secondary" onClick={() => onApproval(required.approvalId!)}>
            Inspect required approval
          </NativeButton>
        ) : null}
      </div>
      {owner.notice ? <p role="status">{owner.notice}</p> : null}
      {owner.attempt.message ? <p role="alert">{owner.attempt.message}</p> : null}
      <ConfirmModal
        open={Boolean(owner.review)}
        title={owner.review ? PACK_ACTION_LABELS[owner.review.action] : "Review setup action"}
        message={
          owner.review
            ? `${packActionDescription(owner.review.plan, owner.review.action)} ${owner.review.plan.impact} Revision ${owner.review.plan.revision}. ${owner.review.plan.requiredAction?.kind === "confirmation" ? owner.review.plan.requiredAction.confirmationText : ""}`
            : ""
        }
        confirmLabel="Submit reviewed plan action"
        cancelLabel="Cancel plan review"
        pending={owner.attempt.phase === "pending"}
        confirmDisabled={owner.attempt.phase !== "idle"}
        onConfirm={() => void owner.confirm()}
        onCancel={owner.cancel}
      />
    </article>
  );
}
