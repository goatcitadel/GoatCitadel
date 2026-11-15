import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";

/** The features that ship turned off and have a switch on Settings › Advanced, in the order that section lists them. */
export const FEATURE_SWITCH_FLAGS = [
  "memoryLifecycleAdminV1Enabled",
  "memoryMaintenanceV1Enabled",
  "chatSkillInstructionsV1Enabled",
  "chatStaticMcpV1Enabled",
  "connectorDiagnosticsV1Enabled",
  "cronReviewQueueV1Enabled",
  "engineeringLearningsV1Enabled",
  "chatProviderFallbackV1Enabled",
  "chatDelegationControlsV1Enabled",
  "utilityModelRoutingV1Enabled",
] as const;
export type FeatureSwitchFlag = (typeof FEATURE_SWITCH_FLAGS)[number];

export interface FeatureSwitchDefinition {
  flag: FeatureSwitchFlag;
  label: string;
  description: string;
  anchor: string;
  usedIn: string;
}

export const FEATURE_SWITCHES_ANCHOR = "feature-switches";
export const FEATURE_SWITCHES_QUERY_KEY = ["system", "settings-feature-switches"] as const;

const SLUGS: Record<FeatureSwitchFlag, string> = {
  memoryLifecycleAdminV1Enabled: "memory-administration",
  memoryMaintenanceV1Enabled: "memory-maintenance",
  chatSkillInstructionsV1Enabled: "skills-in-chat",
  chatStaticMcpV1Enabled: "connectors-in-chat",
  connectorDiagnosticsV1Enabled: "connector-diagnostics",
  cronReviewQueueV1Enabled: "scheduler-review",
  engineeringLearningsV1Enabled: "engineering-learnings",
  chatProviderFallbackV1Enabled: "provider-fallback",
  chatDelegationControlsV1Enabled: "subagents-in-chat",
  utilityModelRoutingV1Enabled: "utility-model",
};

const USED_IN: Record<FeatureSwitchFlag, string> = {
  memoryLifecycleAdminV1Enabled: "Library › Memory",
  memoryMaintenanceV1Enabled: "Library › Memory",
  chatSkillInstructionsV1Enabled: "Chat, and Capabilities › Skills",
  chatStaticMcpV1Enabled: "Chat, and Capabilities › Connectors",
  connectorDiagnosticsV1Enabled: "Capabilities › Connectors › Advanced setup",
  cronReviewQueueV1Enabled: "Work › Schedules",
  engineeringLearningsV1Enabled: "Library › Knowledge",
  chatProviderFallbackV1Enabled: "Each conversation's settings in Chat",
  chatDelegationControlsV1Enabled: "Each conversation's settings in Chat",
  utilityModelRoutingV1Enabled: "Background jobs",
};

export const FEATURE_SWITCHES: readonly FeatureSwitchDefinition[] = FEATURE_SWITCH_FLAGS.map((flag) => {
  const named = CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[flag];
  return {
    flag,
    label: named?.label ?? flag,
    description: named?.description ?? "",
    anchor: `feature-switch-${SLUGS[flag]}`,
    usedIn: USED_IN[flag],
  };
});

export function isFeatureSwitchFlag(value: unknown): value is FeatureSwitchFlag {
  return typeof value === "string" && (FEATURE_SWITCH_FLAGS as readonly string[]).includes(value);
}

export function featureSwitchHref(flag: FeatureSwitchFlag): string {
  return `/settings/advanced#feature-switch-${SLUGS[flag]}`;
}

/** The section anchor and each switch's own anchor, as they appear after the `#` of a link. */
export function isFeatureSwitchHash(hash: string): boolean {
  return hash === FEATURE_SWITCHES_ANCHOR || FEATURE_SWITCHES.some((entry) => entry.anchor === hash);
}

export function featureSwitchLabel(flag: FeatureSwitchFlag): string {
  return CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS[flag]?.label ?? flag;
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
