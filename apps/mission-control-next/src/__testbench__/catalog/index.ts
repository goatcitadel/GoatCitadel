import type { CheckDef } from "../runner/types";
import { approvalChecks } from "./approvals";
import { backupChecks } from "./backups";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { chatTurnChecks } from "./chat-turns";
import { codeModeChecks } from "./code-mode";
import { durableChecks } from "./durable";
import { healthChecks } from "./health";
import { memoryChecks } from "./memory";
import { providerChecks } from "./providers";
import { realtimeChecks } from "./realtime";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
  ...chatTurnChecks,
  ...approvalChecks,
  ...memoryChecks,
  ...durableChecks,
  ...realtimeChecks,
  ...backupChecks,
  ...codeModeChecks,
];
