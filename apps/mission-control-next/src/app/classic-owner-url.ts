/** Detailed Classic controls are a temporary visit, not a new default layout. */
export function buildClassicOwnerUrl(href: string): string {
  const relative = !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);
  const next = new URL(href, "http://goatcitadel.invalid");
  next.searchParams.set("shell", "classic");
  next.searchParams.set("shellScope", "visit");
  return relative ? next.pathname + next.search + next.hash : next.href;
}
