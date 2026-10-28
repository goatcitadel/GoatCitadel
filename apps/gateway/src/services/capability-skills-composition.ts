import type { SkillUseCount } from "@goatcitadel/storage";
import { CapabilitySkillUsageService } from "./capability-skill-usage-service.js";

/** The existing owner of each source the Capabilities Skills tab reads. Each is read-only here. */
export interface CapabilitySkillsOwners {
  chatTurnCapabilityProfiles: { countSkillUsesSince(sinceIso: string): Promise<readonly SkillUseCount[]> };
}

/** The services behind the Capabilities Skills routes. */
export interface CapabilitySkills {
  usage: CapabilitySkillUsageService;
}

/** Wires the Skills tab to its owners. */
export function composeCapabilitySkills({ chatTurnCapabilityProfiles }: CapabilitySkillsOwners): CapabilitySkills {
  return {
    usage: new CapabilitySkillUsageService((sinceIso) => chatTurnCapabilityProfiles.countSkillUsesSince(sinceIso)),
  };
}
