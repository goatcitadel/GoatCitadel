import { useQuery } from "@tanstack/react-query";
import { fetchOnboardingState, fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { useOnboardingDefaults } from "../../../features/native-routes/settings/use-onboarding-defaults";
import { ONBOARDING_DEFAULTS_CONSEQUENCE } from "../../../features/native-routes/settings/onboarding-defaults-binding";
import {
  TOOL_APPROVAL_MODE_OPTIONS,
  describeToolApprovalMode,
  describeToolApprovalModeHelp,
  normalizeToolApprovalMode,
} from "../../../features/native-routes/settings/helpers/permission-helpers";
import {
  BUDGET_MODE_OPTIONS,
  describeBudgetMode,
  labelForBudgetMode,
  normalizeBudgetMode,
} from "../../../features/native-routes/settings/helpers/budget-preferences";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

export function FirstRunDefaults({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: ["system", "first-run-defaults", workspaceId],
    queryFn: async ({ signal }) => {
      const [state, runtime] = await Promise.all([fetchOnboardingState({ signal }), fetchSettings({ signal })]);
      return { state, runtime };
    },
  });
  const control = useOnboardingDefaults({
    state: query.isError ? undefined : query.data?.state,
    runtime: query.isError ? undefined : query.data?.runtime,
    workspaceId,
    active: true,
    onSettled: () => query.refetch(),
  });
  const value = control.draft.value;
  return (
    <section
      aria-label="Advanced first-run defaults"
      className="grid gap-3 rounded-lg border border-line bg-raised p-4"
    >
      <h2 className="font-display text-lg font-semibold text-fg">First-run defaults</h2>
      <p className="text-sm text-fg-secondary">{ONBOARDING_DEFAULTS_CONSEQUENCE}</p>
      {query.isLoading ? <p role="status">Loading current defaults…</p> : null}
      {query.isError ? <p role="alert">Current defaults could not be read.</p> : null}
      {control.notice || control.attempt ? (
        <p role="status" className="text-sm text-fg-secondary">
          {control.attempt?.message ?? control.notice}
        </p>
      ) : null}
      {control.draft.hasRemoteChanges ? (
        <div className="grid gap-2 text-sm text-fg-secondary">
          <p>The settings revision changed. Your draft remains available.</p>
          <Button disabled={control.locked} onClick={control.rebase}>
            Apply draft to current defaults
          </Button>
        </div>
      ) : null}
      <fieldset disabled={control.locked || query.isError || !query.data} className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-fg-secondary">
          Tool approvals
          <select
            className="min-h-10 rounded-md border border-line bg-sunken p-2 text-fg"
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
          <span className="text-xs text-fg-muted">{describeToolApprovalModeHelp(value.toolApprovalMode)}</span>
        </label>
        <label className="grid gap-1 text-sm text-fg-secondary">
          Budget mode
          <select
            className="min-h-10 rounded-md border border-line bg-sunken p-2 text-fg"
            value={value.budgetMode}
            onChange={(event) => control.edit({ ...value, budgetMode: normalizeBudgetMode(event.target.value) })}
          >
            {BUDGET_MODE_OPTIONS.map((mode) => (
              <option key={mode} value={mode}>
                {labelForBudgetMode(mode)}
              </option>
            ))}
          </select>
          <span className="text-xs text-fg-muted">{describeBudgetMode(value.budgetMode)}</span>
        </label>
        <label className="grid gap-1 text-sm text-fg-secondary sm:col-span-2">
          Network allowlist
          <input
            className="min-h-10 rounded-md border border-line bg-sunken p-2 text-fg"
            value={value.networkAllowlist}
            onChange={(event) => control.edit({ ...value, networkAllowlist: event.target.value })}
            placeholder="example.com, api.example.com"
          />
        </label>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!control.canReview} onClick={control.begin}>
          Review defaults
        </Button>
        <Button
          disabled={control.attempt?.phase === "pending" || query.isFetching}
          onClick={() => {
            control.cancel();
            void query.refetch();
          }}
        >
          Refresh defaults
        </Button>
      </div>
      <Dialog
        open={Boolean(control.review)}
        onOpenChange={(open) => {
          if (!open) control.cancel();
        }}
        title="Apply first-run defaults"
        description={ONBOARDING_DEFAULTS_CONSEQUENCE}
      >
        {control.review ? (
          <div className="mb-4 grid gap-2 break-words text-sm text-fg-secondary">
            <p>Tool approvals: {describeToolApprovalMode(control.review.submitted.toolApprovalMode)}</p>
            <p>Budget: {labelForBudgetMode(control.review.submitted.budgetMode)}</p>
            <p>Outbound hosts: {control.review.submitted.networkAllowlist || "None"}</p>
            <p>Loopback auth bypass: off. Revision: {control.review.revision}.</p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={control.locked} onClick={() => void control.confirm()}>
            Confirm defaults
          </Button>
          <Button onClick={control.cancel}>Cancel</Button>
        </div>
      </Dialog>
    </section>
  );
}
