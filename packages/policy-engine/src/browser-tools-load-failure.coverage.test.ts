import { describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";

vi.mock("playwright", () => {
  throw new Error("mocked playwright import failure");
});

import {
  BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE,
  BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE,
  executeBrowserTool,
} from "./browser-tools.js";

describe("browser tools load failure coverage", () => {
  it("falls back with a clear message when the Playwright module cannot be imported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><head><title>Fallback</title></head><body>fallback body</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    const result = await executeBrowserTool(
      "browser.navigate",
      { url: "https://example.com/fallback" },
      createConfig(),
    );

    expect(result).toMatchObject({
      fallbackUsed: true,
      fallbackReason: `${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE}: ${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE}`,
      title: "Fallback",
    });
  });
});

function createConfig(): ToolPolicyConfig {
  return {
    profiles: {
      minimal: ["browser.*"],
    },
    tools: {
      profile: "minimal",
      allow: [],
      deny: [],
    },
    agents: {},
    sandbox: {
      writeJailRoots: ["."],
      readOnlyRoots: ["."],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}
