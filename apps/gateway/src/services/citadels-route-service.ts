import type {
  Citadel,
  CitadelBlueprint,
  CitadelBlueprintValidationResult,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelTemplate,
} from "@goatcitadel/contracts";
import {
  applyCitadelBlueprint,
  applyCitadelTemplate,
  CITADEL_TEMPLATES,
  exportCitadelBlueprint,
  findCitadelTemplate,
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
}
