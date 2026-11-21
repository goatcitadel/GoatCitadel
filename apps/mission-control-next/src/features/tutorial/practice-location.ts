let locationOverride: URL | undefined;

export function practiceLocation(): URL | undefined {
  return locationOverride;
}

export function setPracticeLocation(href: string): void {
  const next = new URL(href, window.location.origin);
  if (next.origin !== window.location.origin) return;
  locationOverride = next;
  window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
}
