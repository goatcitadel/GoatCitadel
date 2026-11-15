import { useEffect } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";
import {
  FEATURE_SWITCHES,
  FEATURE_SWITCHES_ANCHOR,
  isFeatureSwitchHash,
  type FeatureSwitchDefinition,
} from "./feature-switches";

const onOff = (value: boolean) => (value ? "On" : "Off");

/** The Features section of Settings › Advanced: one governed switch per feature that ships turned off. */
export function FeatureSwitchesSettings() {
  const { hash } = useCockpitRoute();
  // A "Turn it on" link from another screen arrives at the top of Advanced; bring its switch into view. The sections
  // above it fill in after this one mounts and push it down, so it is aligned again until the operator scrolls.
  useEffect(() => {
    const id = hash.replace(/^#/u, "");
    if (!isFeatureSwitchHash(id)) return;
    const align = () => document.getElementById(id)?.scrollIntoView?.({ block: "start" });
    let operatorScrolled = false;
    const stop = () => {
      operatorScrolled = true;
    };
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const name of events) window.addEventListener(name, stop, { passive: true });
    const frame = requestAnimationFrame(align);
    const timers = [300, 800, 1600, 3000].map((ms) =>
      window.setTimeout(() => {
        if (!operatorScrolled) align();
      }, ms),
    );
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, stop);
    };
  }, [hash]);
  const settings = useQuery({
    queryKey: ["system", "settings-feature-switches"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  return (
    <section
      id={FEATURE_SWITCHES_ANCHOR}
      aria-labelledby="feature-switches-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="feature-switches-title" className="text-md font-semibold text-fg">
            Features
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            These features are off unless you turn them on here, and each row shows its current state. Each switch turns
            one on or off for the whole installation. Saving one is a Settings change, so it waits for your approval
            unless you&apos;ve chosen to apply Settings changes without asking.
          </p>
        </div>
      </div>
      {FEATURE_SWITCHES.map((definition) => (
        <FeatureSwitchControl key={definition.flag} definition={definition} settings={settings} />
      ))}
    </section>
  );
}

export function FeatureSwitchControl({
  definition,
  settings: query,
}: {
  definition: FeatureSwitchDefinition;
  settings: UseQueryResult<RuntimeSettingsResponse>;
}) {
  const { flag, label, description, anchor, usedIn } = definition;
  const governed = useGovernedRuntimeSetting<boolean>({
    settings: query,
    draftKey: `features:system:${flag}`,
    draftLabel: label,
    recovery: { path: "/settings/advanced", anchor },
    read: (settings) => {
      const value = settings.features?.[flag];
      return typeof value === "boolean" ? value : undefined;
    },
    fallback: false,
    patch: (value) => ({ features: { [flag]: value } }),
    operation: "feature_flag",
    // Only a plan for this exact flag and value settles this draft.
    matchesPlan: (plan: ChangePlanRecord, submitted: boolean) =>
      plan.kind === "runtime_configuration" &&
      plan.request.kind === "runtime_configuration" &&
      plan.request.change.operation === "feature_flag" &&
      plan.request.change.flag === flag &&
      plan.request.change.enabled === submitted &&
      plan.target.ownerId === "runtime_settings",
    copy: {
      staleDraft:
        "Settings changed. Your draft started from an older version. Review the current setting, then apply your draft to the latest version before retrying.",
      changedElsewhere: "Settings changed elsewhere. Your draft is preserved for review.",
      saved: "Setting saved.",
    },
  });
  const { settings, ready, current, draft } = governed;
  const descriptionId = `${anchor}-description`;
  return (
    <div id={anchor} className="mt-4 border-t border-line-subtle pt-4">
      <h4 className="text-sm font-semibold text-fg">{label}</h4>
      <p id={descriptionId} className="mt-1 text-sm text-fg-secondary">
        {description}
      </p>
      <p className="mt-1 text-xs text-fg-muted">Used in: {usedIn}</p>
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading features…"
        incomplete="GoatCitadel did not report this setting. Refresh, or update GoatCitadel, before changing it."
      />
      {ready ? (
        <>
          <p className="mt-3 text-xs text-fg-muted">Current: {onOff(current)}</p>
          <div className="mt-3">
            <Switch
              checked={draft.value}
              label={`Turn it on or off: ${label}`}
              onText=""
              offText=""
              describedBy={descriptionId}
              disabled={governed.locked}
              onCheckedChange={(next) => {
                governed.clearNotice();
                draft.setValue(next);
              }}
            />
          </div>
          <GovernedSettingDraftState
            governed={governed}
            unsaved={`Unsaved draft: ${onOff(draft.value)}`}
            currentLabel={onOff(current)}
          />
          <Button variant="primary" className="mt-3" disabled={!governed.canSave} onClick={() => void governed.save()}>
            {governed.busy ? "Saving…" : "Save setting"}
          </Button>
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">
              features.{flag} · Settings version {settings.data?.revision}
            </p>
          </TechnicalDetails>
        </>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="feature-switch"
        recoveryLabel={`Inspect ${label} setting activity`}
      />
    </div>
  );
}
