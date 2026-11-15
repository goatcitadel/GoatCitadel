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
