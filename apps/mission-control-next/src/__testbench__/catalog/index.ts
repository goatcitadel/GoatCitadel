import type { CheckDef } from "../runner/types";
import { approvalChecks } from "./approvals";
import { backupChecks } from "./backups";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { chatTurnChecks } from "./chat-turns";
import { durableChecks } from "./durable";
import { healthChecks } from "./health";
import { memoryChecks } from "./memory";
import { providerChecks } from "./providers";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
  ...chatTurnChecks,
  ...approvalChecks,
  ...memoryChecks,
  ...durableChecks,
  ...backupChecks,
];
