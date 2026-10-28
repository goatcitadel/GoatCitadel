import type { ChatToolCallCount } from "@goatcitadel/storage";
import { CapabilityToolUsageService } from "./capability-tool-usage-service.js";

/** The existing owner of each source the Capabilities Tools tab reads. Each is read-only here. */
export interface CapabilityToolsOwners {
  chatToolRuns: { countCallsByToolSince(sinceIso: string): Promise<readonly ChatToolCallCount[]> };
}

/** Wires the tool call counts to the chat tool run history. */
export function composeCapabilityToolUsage({ chatToolRuns }: CapabilityToolsOwners): CapabilityToolUsageService {
  return new CapabilityToolUsageService((sinceIso) => chatToolRuns.countCallsByToolSince(sinceIso));
}
