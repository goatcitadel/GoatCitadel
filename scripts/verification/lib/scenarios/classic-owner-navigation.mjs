import { buildClassicOwnerUrl } from "../../../../apps/mission-control-next/src/app/classic-owner-url.ts";

/** Cockpit owner links open Classic as a temporary visit. Build expected hrefs
 * with the product helper so proofs assert the exact link the operator gets. */
export { buildClassicOwnerUrl };

/** InboxOwnerLink routes only classic destinations through ClassicOwnerLink. */
export function inboxOwnerHref(href) {
  const classic = new URL(href, "http://goatcitadel.invalid").searchParams.get("shell") === "classic";
  return classic ? buildClassicOwnerUrl(href) : href;
}

/** The shell marker is set before lazy classic chrome mounts. Await the chrome
 * before deciding whether an actual mobile drawer or collapsed rail needs opening. */
export async function clickClassicOwnerNavigation(page, target) {
  const topbar = page.locator(".mc-next-shell .mc-next-topbar");
  await topbar.waitFor({ state: "visible", timeout: 30_000 });
  if (!(await target.isVisible())) {
    await topbar.getByRole("button", { name: /^(Open navigation|Expand sidebar)$/u }).click();
  }
  await target.waitFor({ state: "visible", timeout: 30_000 });
  await target.click();
}
