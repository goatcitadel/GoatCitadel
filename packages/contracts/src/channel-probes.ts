import type { ChannelSetupFailureCategory } from "./channel-wizard.js";

export type ChannelProbeStepStatus = "pass" | "warn" | "fail" | "skipped";

export interface ChannelProbeStepRecord {
  key: string;
  label: string;
  status: ChannelProbeStepStatus;
  message: string;
  failureCategory?: ChannelSetupFailureCategory;
}

export interface ChannelProbeReport {
  kind: string;
  mode?: string;
  checkedAt: string;
  steps: ChannelProbeStepRecord[];
}
