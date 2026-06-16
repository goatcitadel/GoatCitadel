import type {
  Citadel,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
} from "@goatcitadel/contracts";

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
}
