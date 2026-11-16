import type { IntegrationCatalogEntry } from "@goatcitadel/contracts";

/** The add form's choices: entries that work today first, the rest after them, each group in the catalog's order. */
export function orderCreatableCatalog(entries: readonly IntegrationCatalogEntry[]): IntegrationCatalogEntry[] {
  return [
    ...entries.filter((entry) => entry.maturity === "native"),
    ...entries.filter((entry) => entry.maturity !== "native"),
  ];
}

/** What an option reads: its label, with the maturity said when it is not yet a finished feature. */
export function integrationOptionLabel(entry: IntegrationCatalogEntry): string {
  return entry.maturity === "beta"
    ? `${entry.label} (beta)`
    : entry.maturity === "planned"
      ? `${entry.label} (planned)`
      : entry.label;
}

/** An entry that works through a companion app or bridge on another device, which GoatCitadel does not install. */
export function needsCompanionDevice(entry: IntegrationCatalogEntry): boolean {
  return entry.kind === "platform" || Boolean(entry.formSchema?.fields.some((field) => field.key === "bridgeUrl"));
}

export const COMPANION_DEVICE_NOTE =
  "This one needs a companion app or bridge running on a device that supports it, such as a Mac for Apple apps or a phone for the phone companions. GoatCitadel does not install it.";
