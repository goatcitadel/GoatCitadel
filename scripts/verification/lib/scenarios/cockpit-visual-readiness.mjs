/** Only cockpit navigations receive these preferences. Classic query/theme behavior stays intact. */
export async function installCockpitVisualPreferences(browserContext, variant) {
  await browserContext.addInitScript(({ theme }) => {
    if (new URL(window.location.href).searchParams.get("shell") !== "cockpit") return;
    window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
  }, { theme: variant.colorScheme });
}

/** Executed in the browser: a shell marker alone precedes the lazy route mount. */
export function cockpitVisualShellReady({ pathname, theme, fullscreen }) {
  const root = document.documentElement;
  if (root.dataset.shell !== "cockpit" || root.dataset.theme !== theme || location.pathname !== pathname) return false;
  if (!document.querySelector('[data-cockpit-ready="true"] #main-content') || document.querySelector(".gateway-access-shell")) return false;
  if (document.querySelector(".mc-next-shell")) return false;
  const chrome = fullscreen
    ? document.querySelector('section[aria-label="First-run setup"]')
    : document.querySelector('nav[aria-label="Areas"], nav[aria-label="Areas on small screens"]');
  return Boolean(chrome);
}

/** Do not bless a screenshot of a loading placeholder as a settled native page. */
export function cockpitVisualDataSettled() {
  const main = document.querySelector("#main-content");
  if (!main) return false;
  return !Array.from(main.querySelectorAll('[role="status"], [aria-busy="true"]')).some(element => {
    if (element.getClientRects().length === 0) return false;
    return element.getAttribute("aria-busy") === "true" || /^(Loading\b|Checking setup state|Checking recovery records)/u.test(element.textContent?.trim() ?? "");
  });
}

export async function waitForCockpitVisualRouteReady(page, route, timeoutMs) {
  const href = new URL(route.href, "http://verification.invalid");
  await page.waitForFunction(cockpitVisualShellReady, {
    pathname: href.pathname,
    theme: new URL(page.url()).searchParams.get("theme") === "light" ? "light" : "dark",
    fullscreen: route.fullscreen === true,
  }, { timeout: timeoutMs });
  if (route.readySelector) await page.locator(route.readySelector).first().waitFor({ state: "visible", timeout: timeoutMs });
  if (route.readyText) await page.getByRole("heading", { name: route.readyText, exact: true }).first().waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(cockpitVisualDataSettled, undefined, { timeout: timeoutMs });
}
