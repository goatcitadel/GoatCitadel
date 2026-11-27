import type { RuntimeRepairSweepSnapshot } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

/** Read-only snapshot of the detect-only Runtime Repair Sweep from the Gateway process that answers. */
export function fetchRuntimeRepairs(): Promise<RuntimeRepairSweepSnapshot> {
  return request<RuntimeRepairSweepSnapshot>("/api/v1/ops/runtime-repairs");
}
