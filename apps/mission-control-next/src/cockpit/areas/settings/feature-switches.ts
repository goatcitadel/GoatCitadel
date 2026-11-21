import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { SHIPPED_FEATURE_CONTROLS, SHIPPED_FEATURE_FLAGS, type ShippedFeatureFlag } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";

/** Features with a switch on Settings › Advanced, in that section's display order. */
export const FEATURE_SWITCH_FLAGS = SHIPPED_FEATURE_FLAGS.filter((flag) => SHIPPED_FEATURE_CONTROLS[flag].switchable);
export type FeatureSwitchFlag = ShippedFeatureFlag;

export interface FeatureSwitchDefinition {
  flag: FeatureSwitchFlag;
  label: string;
  description: string;
  anchor: string;
  usedIn: string;
  setup?: { label: string; href: string };
}

export const FEATURE_SWITCHES_ANCHOR = "feature-switches";
export const FEATURE_SWITCHES_QUERY_KEY = ["system", "settings-feature-switches"] as const;

export const FEATURE_SWITCHES: readonly FeatureSwitchDefinition[] = FEATURE_SWITCH_FLAGS.map((flag) => {
  const { label, description, slug, usedIn } = SHIPPED_FEATURE_CONTROLS[flag];
  const control = SHIPPED_FEATURE_CONTROLS[flag];
  return {
    flag,
    label,
    description,
    anchor: `feature-switch-${slug}`,
    usedIn,
    setup: "setup" in control ? control.setup : undefined,
  };
});

export function isFeatureSwitchFlag(value: unknown): value is FeatureSwitchFlag {
  return typeof value === "string" && (FEATURE_SWITCH_FLAGS as readonly string[]).includes(value);
}

export function featureSwitchHref(flag: FeatureSwitchFlag): string {
  return `/settings/advanced#feature-switch-${SHIPPED_FEATURE_CONTROLS[flag].slug}`;
}

/** The section anchor and each switch's own anchor, as they appear after the `#` of a link. */
export function isFeatureSwitchHash(hash: string): boolean {
  return (
    hash === "feature-preference-review" ||
    hash === FEATURE_SWITCHES_ANCHOR ||
    FEATURE_SWITCHES.some((entry) => entry.anchor === hash)
  );
}

export function featureSwitchLabel(flag: FeatureSwitchFlag): string {
  return SHIPPED_FEATURE_CONTROLS[flag].label;
}

/** Whether a feature switch is on, read from the shared Settings query. `undefined` until the Gateway reports a boolean. */
export function useFeatureSwitchOn(flag: FeatureSwitchFlag): boolean | undefined {
  const query = useQuery({
    queryKey: ["system", "settings-feature-switches"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const value = query.data?.features?.[flag];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A screen that read "this feature is turned off" from the Gateway reads again once the switch turns on, so turning it
 * on in Settings never needs a reload. `waiting` is true while that refusal is what the screen shows.
 */
export function useRetryWhenSwitchTurnsOn(flag: FeatureSwitchFlag, waiting: boolean, retry: () => void): void {
  const on = useFeatureSwitchOn(flag);
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (waiting && on === true) latest.current();
  }, [waiting, on]);
}

/**
 * A refusal made on this screen because a feature is turned off. `flag` is set when that switch is the cause, so the
 * screen can link to it; it is left out when the cause is something with no switch of its own (resumable runs).
 */
export class FeatureOffError extends Error {
  readonly flag: FeatureSwitchFlag | undefined;
  constructor(message: string, flag?: FeatureSwitchFlag) {
    super(message);
    this.name = "FeatureOffError";
    this.flag = flag;
  }
}

/** The FeatureOffError behind a refusal, looking through the wrappers a scoped operation puts around it. */
export function featureOffErrorOf(error: unknown): FeatureOffError | undefined {
  for (let depth = 0, current = error; current && depth < 4; depth += 1) {
    if (current instanceof FeatureOffError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
