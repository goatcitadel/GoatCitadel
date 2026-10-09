import { buildClassicOwnerUrl } from "./classic-owner-navigation.mjs";

/** These seeded-fact probes inspect the detailed Classic rollback owners. */
export function classicUiParityProbe(href, route) {
  return { href: buildClassicOwnerUrl(href), route: { ...route, shell: "classic" } };
}
