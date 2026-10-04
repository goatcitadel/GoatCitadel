import type { CheckDef } from "../runner/types";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { healthChecks } from "./health";
import { providerChecks } from "./providers";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
];
