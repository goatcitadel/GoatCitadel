import { GCModal } from "@goatcitadel/mission-control-shared/components/ui/GCModal";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import { SettingsButtonRow, SettingsField, SettingsFieldGrid, SettingsNotice } from "../SettingsShared";
import { useOnboardingDefaults } from "../use-onboarding-defaults";
import { useOnboardingCompletion } from "../use-onboarding-completion";
import { ONBOARDING_DEFAULTS_CONSEQUENCE } from "../onboarding-defaults-binding";
import {
  TOOL_APPROVAL_MODE_OPTIONS,
  describeToolApprovalMode,
  describeToolApprovalModeHelp,
  normalizeToolApprovalMode,
} from "../helpers/permission-helpers";
import {
  BUDGET_MODE_OPTIONS,
  describeBudgetMode,
  labelForBudgetMode,
  normalizeBudgetMode,
} from "../helpers/budget-preferences";

export function OnboardingDefaultsPanel({
  control,
  completion,
  onComplete,
}: {
  control: ReturnType<typeof useOnboardingDefaults>;
  completion: ReturnType<typeof useOnboardingCompletion>;
  onComplete: () => Promise<void>;
}) {
  const value = control.draft.value;
  return (
    <NativeCard title="Apply first-run defaults" subtitle={ONBOARDING_DEFAULTS_CONSEQUENCE}>
      {control.notice || control.attempt ? (
        <SettingsNotice notice={{ tone: "warning", message: control.attempt?.message ?? control.notice! }} />
      ) : null}
      {control.draft.hasRemoteChanges ? (
        <div>
          <p>Defaults changed elsewhere. Your input is preserved.</p>
          <NativeButton disabled={control.locked} onClick={control.rebase}>
            Apply draft to current defaults
          </NativeButton>
        </div>
      ) : null}
      <fieldset disabled={control.locked}>
        <SettingsFieldGrid>
          <SettingsField label="Tool approvals">
            <select
              className="mc-next-settings-input"
              value={value.toolApprovalMode}
              onChange={(event) =>
                control.edit({ ...value, toolApprovalMode: normalizeToolApprovalMode(event.target.value) })
              }
            >
              {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                <option key={mode} value={mode} disabled={mode === "bypass" && control.restricted}>
                  {describeToolApprovalMode(mode)}
                </option>
              ))}
            </select>
            <p className="mc-next-settings-field-note">{describeToolApprovalModeHelp(value.toolApprovalMode)}</p>
            {control.restrictionReason ? (
              <p className="mc-next-settings-field-note">{control.restrictionReason}</p>
            ) : null}
          </SettingsField>
          <SettingsField label="Budget mode">
            <select
              className="mc-next-settings-input"
              value={value.budgetMode}
              onChange={(event) => control.edit({ ...value, budgetMode: normalizeBudgetMode(event.target.value) })}
            >
              {BUDGET_MODE_OPTIONS.map((mode) => (
                <option key={mode} value={mode}>
                  {labelForBudgetMode(mode)}
                </option>
              ))}
            </select>
            <p className="mc-next-settings-field-note">{describeBudgetMode(value.budgetMode)}</p>
          </SettingsField>
          <SettingsField label="Network allowlist" span={2}>
            <input
              className="mc-next-settings-input"
              value={value.networkAllowlist}
              onChange={(event) => control.edit({ ...value, networkAllowlist: event.target.value })}
              placeholder="example.com, api.example.com"
            />
          </SettingsField>
        </SettingsFieldGrid>
      </fieldset>
      <SettingsButtonRow>
        <NativeButton disabled={!control.canReview} onClick={control.begin}>
          Review defaults
        </NativeButton>
        <NativeButton
          variant="secondary"
          disabled={control.attempt?.phase === "pending"}
          onClick={() => void control.refresh()}
        >
          Refresh defaults
        </NativeButton>
        <NativeButton
          variant="secondary"
          disabled={completion.locked || !completion.ready || control.locked}
          onClick={() => void onComplete()}
        >
          Mark complete
        </NativeButton>
      </SettingsButtonRow>
      <GCModal
        open={Boolean(control.review)}
        title="Apply first-run defaults"
        description={ONBOARDING_DEFAULTS_CONSEQUENCE}
        onOpenChange={(open) => {
          if (!open) control.cancel();
        }}
        confirmLabel="Confirm defaults"
        confirmDisabled={control.locked}
        onConfirm={async () => {
          await control.confirm();
        }}
      >
        {control.review ? (
          <>
            <p>Tool approvals: {describeToolApprovalMode(control.review.submitted.toolApprovalMode)}</p>
            <p>Budget: {labelForBudgetMode(control.review.submitted.budgetMode)}</p>
            <p>Network allowlist: {control.review.submitted.networkAllowlist || "None"}</p>
            <p>Loopback auth bypass: off. Revision: {control.review.revision}.</p>
          </>
        ) : null}
      </GCModal>
    </NativeCard>
  );
}
