import type { CitadelCouncilAssignment, CitadelCouncilAssignmentInput, CitadelIntegrationGrant, CitadelIntegrationGrantInput, CitadelStructureSnapshot } from "./citadels.js";
import type { CitadelMember, CitadelMemberInput } from "./citadel-sharing.js";
import type { CitadelPassage, CitadelPassageInput } from "./citadel-passages.js";
import type { CitadelWardInput, CitadelWardRecord } from "./citadel-wards.js";

/** One nonsecret access review, captured under the Citadel owner's transaction. */
export interface CitadelAccessSnapshot {
  citadelId: string;
  revision: string;
  structure: CitadelStructureSnapshot;
  council: CitadelCouncilAssignment[];
  wards: CitadelWardRecord[];
  passages: CitadelPassage[];
  members: CitadelMember[];
  integrations: CitadelIntegrationGrant[];
}

export type CitadelAccessChange =
  | { type: "assign_agent"; assignment: Omit<CitadelCouncilAssignmentInput, "citadelId"> }
  | { type: "unassign_agent"; agentId: string }
  | { type: "add_ward"; ward: Omit<CitadelWardInput, "citadelId"> }
  | { type: "remove_ward"; wardId: string }
  | { type: "create_passage"; passage: Omit<CitadelPassageInput, "sourceCitadelId"> }
  | { type: "remove_passage"; passageId: string }
  | { type: "upsert_member"; member: Omit<CitadelMemberInput, "citadelId"> }
  | { type: "remove_member"; subjectId: string }
  | { type: "add_integration"; integration: Omit<CitadelIntegrationGrantInput, "citadelId"> }
  | { type: "remove_integration"; grantId: string };

export interface CitadelAccessMutation {
  citadelId: string;
  expectedRevision: string;
  change: CitadelAccessChange;
}
