import type { ReactNode } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Callout } from "../../ui/Callout";
import { FeatureOffLink } from "./FeatureOffLink";
import { featureSwitchLabel, isFeatureSwitchFlag, type FeatureSwitchFlag } from "./feature-switches";

/**
 * A "turned off" callout that goes with its switch: the sentence, then the link to Settings › Advanced in the same
 * paragraph. Use it only when this flag is the cause of what the operator sees.
 */
export function FeatureOffNotice({
  flag,
  tone,
  children,
}: {
  flag: FeatureSwitchFlag;
  tone?: "info" | "warning" | "error";
  children?: ReactNode;
}) {
  return (
    <Callout announce={false} tone={tone}>
      {children ?? `${featureSwitchLabel(flag)} is turned off on this installation.`} <FeatureOffLink flag={flag} />
    </Callout>
  );
}

/** The listed switch a Gateway "this feature is turned off" refusal names, if it names one this install can turn on. */
export function listedFeatureFlag(error: unknown): FeatureSwitchFlag | undefined {
  const flag = describeApiError(error).featureFlag;
  return isFeatureSwitchFlag(flag) ? flag : undefined;
}
