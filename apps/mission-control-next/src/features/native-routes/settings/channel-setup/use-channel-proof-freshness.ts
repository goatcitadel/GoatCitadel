import { useEffect, useState } from "react";
import { channelProofExpired, type ChannelSetupWizardFeedback } from "./channel-wizard-model";

/** Re-render at the canonical deadline, with bounded ticks for suspended/changed clocks. */
export function useChannelProofFreshness(feedback?: ChannelSetupWizardFeedback | null) {
  const [tick, setTick] = useState(0);
  const deadline = feedback?.proofExpiresAt;
  useEffect(() => {
    if (feedback?.kind !== "test" || !deadline) return;
    const remaining = Date.parse(deadline) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.min(remaining, 60_000));
    return () => clearTimeout(timer);
  }, [deadline, feedback?.kind, tick]);
  return channelProofExpired(feedback);
}
