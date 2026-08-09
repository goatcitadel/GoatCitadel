import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  launch: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: { launch: mocked.launch },
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocked.spawnSync,
}));

import {
  BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE,
  BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE,
  executeBrowserTool,
} from "./browser-tools.js";

describe("manual Playwright Chromium dependency boundary", () => {
  const originalFetch = globalThis.fetch;
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-manual-chromium-"));
    mocked.launch.mockReset();
    mocked.spawnSync.mockReset();
    mocked.spawnSync.mockImplementation(() => {
      throw new Error("browser tools must never spawn a package manager");
    });
    mocked.launch.mockRejectedValue(
      new Error("browserType.launch: Executable doesn't exist at C:\\missing\\chrome.exe"),
    );
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><head><title>HTTP fallback</title></head><body>fallback body</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("launches once per read attempt, never installs, and preserves HTTP fallbacks across repeated failures", async () => {
    const config = createConfig(tempRoot);
    const expectedDiagnostic = manualRequiredDiagnostic();

    const navigate = await executeBrowserTool("browser.navigate", { url: "https://example.com/first" }, config);
    const extract = await executeBrowserTool(
      "browser.extract",
      { url: "https://example.com/second", selector: "main" },
      config,
    );

    expect(navigate).toMatchObject({
      fallbackUsed: true,
      fallbackReason: expectedDiagnostic,
      title: "HTTP fallback",
    });
    expect(extract).toMatchObject({
      fallbackUsed: true,
      fallbackReason: expectedDiagnostic,
      text: "HTTP fallback fallback body",
    });
    expect(mocked.launch).toHaveBeenCalledTimes(2);
    expect(mocked.spawnSync).not.toHaveBeenCalled();
  });

  it("fails native-only screenshot and interaction with the stable manual-required diagnostic", async () => {
    const config = createConfig(tempRoot);
    const expectedDiagnostic = manualRequiredDiagnostic();

    await expect(
      executeBrowserTool(
        "browser.screenshot",
        { url: "https://example.com/shot", outputPath: path.join(tempRoot, "shot.png") },
        config,
      ),
    ).rejects.toThrow(expectedDiagnostic);
    await expect(
      executeBrowserTool(
        "browser.interact",
        {
          url: "https://example.com/interact",
          steps: [{ action: "click", selector: "button" }],
        },
        config,
      ),
    ).rejects.toThrow(expectedDiagnostic);
    expect(mocked.launch).toHaveBeenCalledTimes(2);
    expect(mocked.spawnSync).not.toHaveBeenCalled();
  });
});

function manualRequiredDiagnostic(): string {
  return `${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE}: ${BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_MESSAGE}`;
}

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: { minimal: ["browser.*"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}
