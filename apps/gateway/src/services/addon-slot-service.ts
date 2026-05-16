import type { AddonDashboardSlot, AddonDashboardSlotDeclaration } from "@goatcitadel/contracts";

export interface AddonSlotRegistration extends AddonDashboardSlotDeclaration {
  addonId: string;
}

export class AddonSlotService {
  private readonly byAddon = new Map<string, AddonDashboardSlotDeclaration[]>();

  public registerDeclarations(addonId: string, declarations: AddonDashboardSlotDeclaration[]): void {
    this.byAddon.set(
      addonId,
      declarations.map((d) => ({ ...d })),
    );
  }

  public unregister(addonId: string): void {
    this.byAddon.delete(addonId);
  }

  public findSlotsForRoute(route: string, slotFilter?: AddonDashboardSlot): AddonSlotRegistration[] {
    const matches: AddonSlotRegistration[] = [];
    for (const [addonId, declarations] of this.byAddon.entries()) {
      for (const declaration of declarations) {
        if (slotFilter && declaration.slot !== slotFilter) continue;
        if (declaration.route && declaration.route !== route) continue;
        matches.push({ addonId, ...declaration });
      }
    }
    matches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return matches;
  }

  public listAllRegistrations(): AddonSlotRegistration[] {
    const items: AddonSlotRegistration[] = [];
    for (const [addonId, declarations] of this.byAddon.entries()) {
      for (const declaration of declarations) {
        items.push({ addonId, ...declaration });
      }
    }
    return items;
  }
}
