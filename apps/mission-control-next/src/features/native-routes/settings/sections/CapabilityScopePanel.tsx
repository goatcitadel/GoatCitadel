import { useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { SettingsButtonRow } from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { ErrorState, NativeButton, NativeSelectableList } from "../../primitives";
import { useCapabilityScope, type CapabilityScopeOptions } from "../use-capability-scope";

export interface CapabilityScopePanelProps extends CapabilityScopeOptions {
  title: string;
}
export function CapabilityScopePanel({ title, ...options }: CapabilityScopePanelProps) {
  const scope = useCapabilityScope(options),
    [limit, setLimit] = useState(30);
  const { view, review } = scope;
  const pending = scope.attempt.phase === "checking" || scope.attempt.phase === "saving";
  const labels = new Map(view?.items.map((item) => [item.resourceRef, item.label]));
  const selections = Object.entries(scope.draft.value);
  const selected = review?.assignments.filter((item) => item.enabled) ?? [];
  const summary = review?.reset
    ? "Remove this saved selection and inherit the parent’s current and future choices."
    : `Save the complete selection: ${selected.length} included, ${(review?.assignments.length ?? 0) - selected.length} excluded. Included: ${
        selected
          .slice(0, 8)
          .map((item) => (labels.get(item.resourceRef) ?? item.resourceRef).slice(0, 100))
          .join(", ") || "none"
      }${selected.length > 8 ? "…" : ""}.`;
  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title={title}
      subtitle={`Saved ${options.scopeKind} selection. ${view?.mode === "inherit" ? "Inherited" : "Curated"}. Live availability and policy remain separate.`}
    >
      {scope.loading ? <p role="status">Reading the current scope…</p> : null}
      {scope.error ? <ErrorState size="inline" description={scope.error} /> : null}
      {scope.notice ? <p role="status">{scope.notice}</p> : null}
      {scope.attempt.message ? <p role="status">{scope.attempt.message}</p> : null}
      {view && !scope.supported ? (
        <p role="status">
          Reviewed editing is unavailable for this Gateway or selection. This panel requires an exact scope review and
          at most 1,000 references.
        </p>
      ) : null}
      {scope.supported && !scope.active ? (
        <p>Restore this scope and its Citadel before changing the selection.</p>
      ) : null}
      {scope.draft.hasRemoteChanges ? (
        <p role="status">Saved scope changed. Discard this draft to review current choices.</p>
      ) : null}
      <NativeSelectableList
        ariaLabel={`${title} for ${options.scopeKind}`}
        emptyLabel={`No ${title.toLowerCase()} references returned.`}
      >
        {(view?.items ?? []).slice(0, limit).map((item) => (
          <button
            key={item.resourceRef}
            type="button"
            className="mc-next-settings-selectable"
            aria-pressed={scope.draft.value[item.resourceRef] ?? item.enabled}
            disabled={!scope.supported || !scope.active || scope.loading}
            onClick={() => scope.toggle(item.resourceRef)}
          >
            <div className="mc-next-settings-selectable-head">
              <strong>
                {item.label}
                {!item.available ? " (unavailable)" : ""}
              </strong>
              <span>{(scope.draft.value[item.resourceRef] ?? item.enabled) ? "Selected" : "Excluded"}</span>
            </div>
          </button>
        ))}
      </NativeSelectableList>
      {(view?.items.length ?? 0) > limit ? (
        <NativeButton variant="secondary" onClick={() => setLimit((value) => value + 30)}>
          Show more references
        </NativeButton>
      ) : null}
      <p className="mc-next-settings-field-note">
        {selections.filter(([, enabled]) => enabled).length} of {selections.length} references selected. An unavailable
        selected reference is not made callable. Denies, approvals, grants and runtime availability still apply.
      </p>
      <SettingsButtonRow>
        <NativeButton disabled={!scope.ready || !scope.draft.isDirty} onClick={() => scope.requestReview()}>
          Review &amp; Save
        </NativeButton>
        <NativeButton
          variant="secondary"
          disabled={!scope.ready || view?.mode === "inherit"}
          onClick={() => scope.requestReview(true)}
        >
          Reset to inherited
        </NativeButton>
        <NativeButton variant="secondary" disabled={pending} onClick={() => void scope.reload()}>
          Refresh
        </NativeButton>
        {scope.draft.isDirty ? (
          <NativeButton variant="secondary" disabled={pending} onClick={scope.discard}>
            Discard selection draft
          </NativeButton>
        ) : null}
      </SettingsButtonRow>
      <ConfirmModal
        open={Boolean(review)}
        title={review?.reset ? "Review inherited selection" : "Review capability selection"}
        message={`${summary} This changes saved capability selection only; it does not install, connect or invoke a capability, or grant permission. Workspace selections can only narrow their Citadel.`}
        confirmLabel="Apply reviewed selection"
        cancelLabel="Cancel scope review"
        pending={pending}
        confirmDisabled={!scope.ready}
        onConfirm={() => void scope.confirm()}
        onCancel={scope.cancelReview}
      />
    </NativeCard>
  );
}
