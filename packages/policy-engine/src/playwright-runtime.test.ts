import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ launch: vi.fn(), importFails: false }));

vi.mock("playwright", () => {
  if (mocked.importFails) throw new Error("Cannot find module 'playwright'");
  return { chromium: { launch: mocked.launch } };
});

import {
  BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE,
  BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE,
  BROWSER_CHROMIUM_SECURITY_ARGS,
  isMissingPlaywrightBrowserError,
  launchPlaywrightChromium,
  loadPlaywright,
} from "./playwright-runtime.js";

describe("playwright runtime", () => {
  it("launches headless Chromium with the WebRTC security argument", async () => {
    const browser = { close: vi.fn() };
    mocked.launch.mockResolvedValueOnce(browser);

    const playwright = await loadPlaywright();
    await expect(launchPlaywrightChromium(playwright, true)).resolves.toBe(browser);
    expect(mocked.launch).toHaveBeenCalledWith({
      headless: true,
      args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    expect(BROWSER_CHROMIUM_SECURITY_ARGS).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("maps a missing browser executable to the manual-install diagnostic and leaves other errors alone", async () => {
    const playwright = await loadPlaywright();
    mocked.launch.mockRejectedValueOnce(new Error("browserType.launch: Executable doesn't exist at /x/chrome"));
    await expect(launchPlaywrightChromium(playwright, true)).rejects.toThrow(
      `${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE}: ${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE}`,
    );
    expect(isMissingPlaywrightBrowserError(new Error("browserType.launch: Executable doesn't exist"))).toBe(true);
    expect(isMissingPlaywrightBrowserError(new Error("net::ERR_FAILED"))).toBe(false);

    mocked.launch.mockRejectedValueOnce(new Error("net::ERR_FAILED"));
    await expect(launchPlaywrightChromium(playwright, true)).rejects.toThrow("net::ERR_FAILED");
  });
});
