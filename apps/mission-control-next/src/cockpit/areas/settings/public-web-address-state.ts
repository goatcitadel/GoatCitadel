import { useQuery } from "@tanstack/react-query";
import { checkPublicWebAddress, type ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";

/**
 * The settings read the public web address comes from. It shares the Web & Search page's key, so the settings are
 * fetched once however many places show the address, and a settings change refreshes them all
 * (`SETTINGS_READER_KEYS`). Nothing here polls: a save or a change event is what updates it.
 */
export function usePublicWebAddressQuery() {
  return useQuery({ queryKey: ["system", "settings-web-search"], queryFn: () => fetchSettings() });
}

/** The settings as GoatCitadel last reported them, or undefined until they are read or when they can't be. */
export function usePublicWebAddressSettings(): RuntimeSettingsResponse | undefined {
  return usePublicWebAddressQuery().data;
}

/** The operator's public web address, or undefined when none is set or the settings can't be read. */
export function usePublicWebAddress(): string | undefined {
  return usePublicWebAddressSettings()?.publicWebAddress || undefined;
}

/** The saved address. No address is the empty string, so the draft and the saved value compare as text. */
export const readPublicWebAddress = (settings: RuntimeSettingsResponse): string => settings.publicWebAddress ?? "";

/**
 * What GoatCitadel saves for an address typed here: the same check it runs, so the lower-cased host and the missing
 * trailing slash are known before the save. An address the check refuses is left as typed; it is never sent.
 */
export function normalizePublicWebAddress(value: string): string {
  const typed = value.trim();
  if (!typed) return "";
  const checked = checkPublicWebAddress(typed);
  return checked.ok ? checked.address : typed;
}

/** The change a save of this address plans: the address as saved, or none when it is cleared. */
export const matchesPublicWebAddressPlan = (plan: ChangePlanRecord, submitted: string): boolean =>
  plan.request.kind === "runtime_configuration" &&
  plan.request.change.operation === "public_web_address_configuration" &&
  plan.target.ownerId === "runtime_settings" &&
  (plan.request.change.config.publicWebAddress ?? "") === normalizePublicWebAddress(submitted);
