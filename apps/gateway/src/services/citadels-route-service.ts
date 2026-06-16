import type {
  Citadel,
  CitadelBlueprint,
  CitadelBlueprintValidationResult,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCouncilAssignment,
  CitadelCouncilAssignmentInput,
  CitadelGatehouseSummary,
  CitadelMember,
  CitadelMemberInput,
  CitadelPassage,
  CitadelPassageInput,
  CitadelTemplate,
  CitadelWardInput,
  CitadelWardRecord,
} from "@goatcitadel/contracts";
import {
  applyCitadelBlueprint,
  applyCitadelTemplate,
  CITADEL_TEMPLATES,
  exportCitadelBlueprint,
  findCitadelTemplate,
  summarizeCitadelGatehouse,
  validateCitadelBlueprint,
} from "@goatcitadel/contracts";

export type CitadelImportResult = { ok: false; errors: string[] } | { ok: true; citadel: Citadel };

/**
 * Minimal port over the Citadel persistence layer (satisfied structurally by the
 * storage CitadelRepository) so routes depend on behaviour, not the concrete repo.
 */
export interface CitadelsRoutePort {
  getCitadel(citadelId: string): Citadel | undefined;
  upsertCharter(input: CitadelCharterInput): CitadelCharter;
  createChamber(input: CitadelChamberInput): CitadelChamber;
  listChambers(citadelId: string): CitadelChamber[];
  assignAgent(input: CitadelCouncilAssignmentInput): CitadelCouncilAssignment;
  listCouncilAssignments(citadelId: string): CitadelCouncilAssignment[];
  unassignAgent(citadelId: string, agentId: string): boolean;
  addWard(input: CitadelWardInput): CitadelWardRecord;
  listWards(citadelId: string): CitadelWardRecord[];
  removeWard(citadelId: string, wardId: string): boolean;
  createPassage(input: CitadelPassageInput): CitadelPassage;
  listPassages(sourceCitadelId: string): CitadelPassage[];
  removePassage(sourceCitadelId: string, passageId: string): boolean;
  upsertMember(input: CitadelMemberInput): CitadelMember;
  listMembers(citadelId: string): CitadelMember[];
  removeMember(citadelId: string, subjectId: string): boolean;
}

export class CitadelsRouteService {
  public constructor(private readonly citadels: CitadelsRoutePort) {}

  public getCitadel(citadelId: string): Citadel | undefined {
    return this.citadels.getCitadel(citadelId);
  }

  public upsertCharter(input: CitadelCharterInput): CitadelCharter {
    return this.citadels.upsertCharter(input);
  }

  public createChamber(input: CitadelChamberInput): CitadelChamber {
    return this.citadels.createChamber(input);
  }

  public listChambers(citadelId: string): CitadelChamber[] {
    return this.citadels.listChambers(citadelId);
  }

  public listTemplates(): CitadelTemplate[] {
    return CITADEL_TEMPLATES;
  }

  public createFromTemplate(citadelId: string, templateId: string): Citadel | undefined {
    const template = findCitadelTemplate(templateId);
    if (!template) {
      return undefined;
    }
    return applyCitadelTemplate(this.citadels, citadelId, template);
  }

  public exportBlueprint(citadelId: string): CitadelBlueprint | undefined {
    const citadel = this.citadels.getCitadel(citadelId);
    if (!citadel) {
      return undefined;
    }
    return exportCitadelBlueprint(citadel);
  }

  public validateBlueprint(value: unknown): CitadelBlueprintValidationResult {
    return validateCitadelBlueprint(value);
  }

  public createFromBlueprint(citadelId: string, value: unknown): CitadelImportResult {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, citadel: applyCitadelBlueprint(this.citadels, citadelId, value as CitadelBlueprint) };
  }

  public getGatehouse(citadelId: string): (CitadelGatehouseSummary & { wardCount: number }) | undefined {
    const citadel = this.citadels.getCitadel(citadelId);
    if (!citadel) {
      return undefined;
    }
    return { ...summarizeCitadelGatehouse(citadel), wardCount: this.citadels.listWards(citadelId).length };
  }

  public listWards(citadelId: string): CitadelWardRecord[] {
    return this.citadels.listWards(citadelId);
  }

  public addWard(input: CitadelWardInput): CitadelWardRecord {
    return this.citadels.addWard(input);
  }

  public removeWard(citadelId: string, wardId: string): boolean {
    return this.citadels.removeWard(citadelId, wardId);
  }

  /** The Council is the set of existing agents assigned to this Citadel (by id). */
  public listCouncil(citadelId: string): CitadelCouncilAssignment[] {
    return this.citadels.listCouncilAssignments(citadelId);
  }

  public assignAgent(input: CitadelCouncilAssignmentInput): CitadelCouncilAssignment {
    return this.citadels.assignAgent(input);
  }

  public unassignAgent(citadelId: string, agentId: string): boolean {
    return this.citadels.unassignAgent(citadelId, agentId);
  }

  public listPassages(sourceCitadelId: string): CitadelPassage[] {
    return this.citadels.listPassages(sourceCitadelId);
  }

  public createPassage(input: CitadelPassageInput): CitadelPassage {
    return this.citadels.createPassage(input);
  }

  public removePassage(sourceCitadelId: string, passageId: string): boolean {
    return this.citadels.removePassage(sourceCitadelId, passageId);
  }

  public listMembers(citadelId: string): CitadelMember[] {
    return this.citadels.listMembers(citadelId);
  }

  public upsertMember(input: CitadelMemberInput): CitadelMember {
    return this.citadels.upsertMember(input);
  }

  public removeMember(citadelId: string, subjectId: string): boolean {
    return this.citadels.removeMember(citadelId, subjectId);
  }
}
