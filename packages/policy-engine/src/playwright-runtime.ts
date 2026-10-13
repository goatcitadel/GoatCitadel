/**
 * The Playwright runtime boundary shared by the browser tools and the HTML renderer: lazy module
 * load, the hardened Chromium launch, and the operator-facing diagnostic when the browser is not
 * installed. Nothing here installs anything; an operator must install Chromium themselves.
 */

export const BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE = "browser_chromium_manual_install_required" as const;
export const BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE =
  'Playwright Chromium is unavailable. Automatic installation is disabled; an operator must install workspace dependencies, run "pnpm --filter @goatcitadel/policy-engine exec playwright install chromium", and retry.' as const;

export const BROWSER_CHROMIUM_SECURITY_ARGS: readonly string[] = Object.freeze([
  // Browser-context proxies do not cover WebRTC's direct UDP candidates.
  // Refuse non-proxied UDP so hostile pages cannot use STUN/ICE to reach
  // loopback, LAN, or metadata endpoints outside the guarded SOCKS proxy.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]);

/** The narrowest Playwright surface the launcher needs; callers refine the browser type they expect. */
export interface PlaywrightLauncherLike<TBrowser> {
  chromium: {
    launch: (options: { headless: boolean; args?: string[] }) => Promise<TBrowser>;
  };
}

export async function loadPlaywright<
  TModule extends PlaywrightLauncherLike<unknown> = PlaywrightLauncherLike<unknown>,
>(): Promise<TModule> {
  const moduleName = "playwright";
  try {
    const loaded = await import(moduleName);
    return loaded as TModule;
  } catch (error) {
    throw browserChromiumManualRequiredError(error);
  }
}

export async function launchPlaywrightChromium<TBrowser>(
  playwright: PlaywrightLauncherLike<TBrowser>,
  headless: boolean,
): Promise<TBrowser> {
  const launchOptions = { headless, args: [...BROWSER_CHROMIUM_SECURITY_ARGS] };
  try {
    return await playwright.chromium.launch(launchOptions);
  } catch (error) {
    if (isMissingPlaywrightBrowserError(error)) throw browserChromiumManualRequiredError(error);
    throw error;
  }
}

export function isMissingPlaywrightBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /browsertype\.launch: executable doesn't exist/i.test(message);
}

export function browserChromiumManualRequiredError(cause: unknown): Error {
  return new Error(
    `${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE}: ${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE}`,
    { cause },
  );
}
