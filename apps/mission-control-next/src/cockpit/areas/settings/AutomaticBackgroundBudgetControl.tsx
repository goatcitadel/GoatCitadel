import type { UseQueryResult } from "@tanstack/react-query";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { useModelLabel } from "../../data/use-model-label";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { cockpitInputClass } from "../../ui/input-class";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 });
const reasons: Record<string, string> = {
  autonomy_disabled: "Automatic work is paused.",
  provider_unavailable: "Choose a model for background work in Settings › Models.",
  background_budget_exhausted: "Today's paid allowance is used or reserved. Eligible local models can still run.",
  installation_budget_exhausted: "The installation's daily spending limit has been reached.",
  pricing_unavailable: "GoatCitadel needs a model with known prices for paid background work.",
  budget_unavailable: "Usage needs reconciliation before paid background work can continue.",
};

export function AutomaticBackgroundBudgetControl({ settings }: { settings: UseQueryResult<RuntimeSettingsResponse> }) {
  const governed = useGovernedRuntimeSetting<string>({
    settings,
    draftKey: "budget:system:automatic-background",
    draftLabel: "Automatic background budget",
    recovery: { path: "/settings/safety", anchor: "automatic-background-budget" },
    read: (current) =>
      current.automaticBackgroundUsdCap === undefined ? undefined : String(current.automaticBackgroundUsdCap),
    fallback: "",
    normalize: (value) => String(Number(value)),
    patch: (value) => ({ automaticBackgroundUsdCap: Number(value) }),
    operation: "automatic_background_budget",
    copy: {
      saved: "Automatic background budget saved.",
      staleDraft: "The spending limit changed. Review the updated amount before saving.",
      changedElsewhere: "The spending limit changed elsewhere. Your draft is available for review.",
    },
  });
  const stats = settings.data?.automaticBackground;
  const modelLabel = useModelLabel(stats?.model?.providerId, stats?.model?.model, Boolean(stats?.model), {
    showIdWhenUnnamed: false,
  });
  const draft = governed.draft.value;
  const invalid = !draft.trim() || !Number.isFinite(Number(draft)) || Number(draft) < 0;
  return (
    <section
      id="automatic-background-budget"
      aria-labelledby="automatic-background-budget-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <h3 id="automatic-background-budget-title" className="text-md font-semibold text-fg">
        Automatic background budget
      </h3>
      <p className="mt-1 text-sm text-fg-secondary">
        Limit what GoatCitadel can spend on automatic background model calls each UTC day. The installation-wide limit
        also applies.
      </p>
      {stats ? (
        <div className="mt-3 space-y-1 break-words text-sm text-fg-secondary">
          <p>
            {stats.utcDay} UTC · {usd.format(stats.spentUsd)} spent · {usd.format(stats.reservedUsd)} reserved for{" "}
            {stats.pendingCount} pending {stats.pendingCount === 1 ? "call" : "calls"}
          </p>
          <p>Effective daily limit {usd.format(stats.limitUsd)}</p>
          {stats.model ? (
            <>
              <p>Background model · {modelLabel}</p>
              <TechnicalDetails>
                <code>
                  {stats.model.providerId} / {stats.model.model}
                </code>
              </TechnicalDetails>
            </>
          ) : null}
          {stats.limitUsd === 0 ? (
            <p>Paid automatic background calls are off.</p>
          ) : stats.reason ? (
            <p>{reasons[stats.reason] ?? "Background work needs attention."}</p>
          ) : null}
          <NativeOwnerLink href="/settings/models" scope="automatic-background-budget">
            Open model settings
          </NativeOwnerLink>
        </div>
      ) : settings.data ? (
        <p className="mt-2 text-sm text-fg-muted">Today's background usage is unavailable.</p>
      ) : null}
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading spending limit…"
        incomplete="The spending limit is unavailable. Refresh Settings to try again."
      />
      {governed.ready ? (
        <>
          <div className="mt-3 max-w-sm">
            <Field
              label="Daily cap in US dollars"
              help="Set zero to stop paid automatic background calls. Eligible local models remain available."
              error={governed.draft.isDirty && invalid ? "Enter an amount of zero or more." : undefined}
            >
              {(props) => (
                <input
                  {...props}
                  className={cockpitInputClass}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={draft}
                  onChange={(event) => {
                    governed.clearNotice();
                    governed.draft.setValue(event.currentTarget.value);
                  }}
                  disabled={governed.locked}
                />
              )}
            </Field>
          </div>
          <GovernedSettingDraftState
            governed={governed}
            unsaved="Unsaved spending limit"
            currentLabel={usd.format(Number(governed.current))}
          />
          <Button
            variant="primary"
            className="mt-3"
            disabled={!governed.canSave || invalid}
            onClick={() => void governed.save()}
          >
            {governed.busy ? "Saving…" : "Save daily cap"}
          </Button>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="automatic-background-budget"
        recoveryLabel="Inspect spending limit activity"
      />
    </section>
  );
}
