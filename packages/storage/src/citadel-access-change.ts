import { NotFoundError, ValidationError, type CitadelAccessChange } from "@goatcitadel/contracts";
import type { CitadelRepository } from "./citadel-repo.js";

type AccessWriter = Pick<CitadelRepository, "assignAgent" | "unassignAgent" | "addWard" | "removeWard"
  | "getChamber" | "createPassage" | "removePassage" | "upsertMember" | "removeMember"
  | "addIntegrationGrant" | "removeIntegrationGrant">;

/** Called by mutateAccess only after revision/lifecycle checks, inside its transaction. */
export function applyCitadelAccessChange(owner: AccessWriter, citadelId: string, change: CitadelAccessChange): void {
  let removed = true;
  switch (change.type) {
    case "assign_agent": owner.assignAgent({ ...change.assignment, citadelId }); break;
    case "unassign_agent": removed = owner.unassignAgent(citadelId, change.agentId); break;
    case "add_ward": owner.addWard({ ...change.ward, citadelId }); break;
    case "remove_ward": removed = owner.removeWard(citadelId, change.wardId); break;
    case "create_passage": {
      if (change.passage.sourceChamberId && owner.getChamber(change.passage.sourceChamberId)?.citadelId !== citadelId) {
        throw new ValidationError({ message: "The Passage source Chamber must belong to this Citadel." });
      }
      owner.createPassage({ ...change.passage, sourceCitadelId: citadelId });
      break;
    }
    case "remove_passage": removed = owner.removePassage(citadelId, change.passageId); break;
    case "upsert_member": owner.upsertMember({ ...change.member, citadelId }); break;
    case "remove_member": removed = owner.removeMember(citadelId, change.subjectId); break;
    case "add_integration": owner.addIntegrationGrant({ ...change.integration, citadelId }); break;
    case "remove_integration": removed = owner.removeIntegrationGrant(citadelId, change.grantId); break;
    default: throw new ValidationError({ message: "Unsupported Citadel access change." });
  }
  if (!removed) throw new NotFoundError({ entity: "Citadel access rule" });
}
