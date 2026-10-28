import type { ChangePlanStatus } from "@goatcitadel/contracts";

/** A plan in one of these has made its change; nothing is left to wait for. */
export const DONE: ReadonlySet<ChangePlanStatus> = new Set(["completed", "applied", "monitoring"]);

/** A plan in one of these has stopped without making its change (or without finishing it), and won't go on. */
export const ENDED: ReadonlySet<ChangePlanStatus> = new Set([
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
  "manual_required",
]);
