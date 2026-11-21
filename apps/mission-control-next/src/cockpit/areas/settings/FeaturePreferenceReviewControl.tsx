import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { SHIPPED_FEATURE_CONTROLS, type ShippedFeatureFlag } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { GovernedSettingChangeStatus } from "./GovernedSettingParts";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";

export function FeaturePreferenceReviewControl({
  settings,
  flags,
}: {
  settings: UseQueryResult<RuntimeSettingsResponse>;
  flags: ShippedFeatureFlag[];
}) {
  const [selection, setSelection] = useState<ShippedFeatureFlag | "all">("all");
  const choice = selection !== "all" && flags.includes(selection) ? selection : "all";
  const selected = choice === "all" ? flags : [choice];
  const [busy, setBusy] = useState(false);
  return (
    <details className="mt-4 border-t border-line-subtle pt-4" id="feature-preference-review">
      <summary className="cursor-pointer text-sm font-semibold text-fg">Review existing feature settings</summary>
      <p className="my-2 text-sm text-fg-secondary">
        These features are still off from an earlier installation. Choose which should follow the new defaults.
      </p>
      <Field label="Features to review">
        {(props) => (
          <select
            {...props}
            className={cockpitInputClass}
            disabled={busy}
            value={choice}
            onChange={(event) => setSelection(event.target.value as typeof selection)}
          >
            <option value="all">All {flags.length} features</option>
            {flags.map((flag) => (
              <option key={flag} value={flag}>
                {SHIPPED_FEATURE_CONTROLS[flag].label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <ul className="my-2 list-inside list-disc text-sm text-fg-secondary">
        {selected.map((flag) => (
          <li key={flag}>{SHIPPED_FEATURE_CONTROLS[flag].label}</li>
        ))}
      </ul>
      <ReviewActions key={selected.join("-")} settings={settings} flags={selected} onBusy={setBusy} />
    </details>
  );
}

function ReviewActions({
  settings,
  flags,
  onBusy,
}: {
  settings: UseQueryResult<RuntimeSettingsResponse>;
  flags: ShippedFeatureFlag[];
  onBusy: (busy: boolean) => void;
}) {
  const governed = useGovernedRuntimeSetting<"pending" | "inherit" | "off">({
    settings,
    draftKey: `features:review:${flags.join("-")}`,
    draftLabel: "Existing feature settings",
    recovery: { path: "/settings/advanced", anchor: "feature-preference-review" },
    read: (current) => {
      const metadata = current.featurePreferences;
      if (!metadata) return undefined;
      if (flags.every((flag) => metadata.sources[flag] === "operator" && current.features[flag] === false))
        return "off";
      if (flags.every((flag) => metadata.sources[flag] === "default" || metadata.sources[flag] === "environment"))
        return "inherit";
      return "pending";
    },
    fallback: "pending",
    patch: (decision) => ({
      featureReview: {
        flags,
        fingerprint: settings.data!.featurePreferences!.upgradeFingerprint,
        decision: decision === "off" ? "off" : "inherit",
      },
    }),
    operation: "feature_preference_review",
    matchesPlan: (plan, decision) => {
      const change = plan.request.kind === "runtime_configuration" ? plan.request.change : undefined;
      return (
        change?.operation === "feature_preference_review" &&
        change.decision === decision &&
        change.flags.length === flags.length &&
        change.flags.every((flag) => flags.includes(flag)) &&
        plan.target.ownerId === "runtime_settings"
      );
    },
    copy: {
      staleDraft: "Settings changed. Review the remaining features before saving.",
      changedElsewhere: "Settings changed elsewhere. Review the current feature settings.",
      saved: "Feature preferences saved.",
    },
  });
  useEffect(() => {
    onBusy(governed.locked);
    return () => onBusy(false);
  }, [governed.locked, onBusy]);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!governed.ready || governed.locked} onClick={() => void governed.save("inherit")}>
          Use new defaults
        </Button>
        <Button size="sm" disabled={!governed.ready || governed.locked} onClick={() => void governed.save("off")}>
          Keep Off
        </Button>
      </div>
      <GovernedSettingChangeStatus
        governed={governed}
        owner="feature-switch"
        recoveryLabel="Inspect feature setting activity"
      />
    </>
  );
}
