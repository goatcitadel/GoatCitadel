import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { executeTool } from "./tool-executor.js";
import { BROWSER_ERRAND_TOOL_NAME, createDefaultToolRegistry } from "./tool-registry.js";

const storage = {} as AsyncStorage;
const config: ToolPolicyConfig = {
  tools: { approvalMode: "approve_risky", allow: ["*"], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: [],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

function request(overrides: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return {
    toolName: BROWSER_ERRAND_TOOL_NAME,
    args: { goal: "find a USB-C hub under $40" },
    agentId: "assistant",
    sessionId: "session-1",
    turnId: "turn-1",
    toolRunId: "tool-run-1",
    ...overrides,
  };
}

describe("browser.errand executor", () => {
  it("routes browser.errand to the runBrowserErrand hook", async () => {
    const hookResult = { outcome: "done", summary: "Found one.", steps: 3, modelRequests: 4, visitedUrls: [] };
    const runBrowserErrand = vi.fn(async () => hookResult);

    const result = await executeTool(request(), config, storage, { runBrowserErrand });

    expect(runBrowserErrand).toHaveBeenCalledTimes(1);
    expect(runBrowserErrand).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "browser.errand", args: { goal: "find a USB-C hub under $40" } }),
    );
    expect(result).toMatchObject(hookResult);
  });

  it("says errands are unavailable without the hook", async () => {
    await expect(executeTool(request(), config, storage, {})).rejects.toThrow(
      "Browser errands are not available here.",
    );
  });

  it("registers browser.errand as a caution browser tool that needs no call-level approval", () => {
    const definition = createDefaultToolRegistry()
      .list()
      .find((tool) => tool.name === BROWSER_ERRAND_TOOL_NAME);
    expect(definition).toMatchObject({
      category: "browser",
      riskLevel: "caution",
      requiresApproval: false,
      readOnly: false,
      codeModeAllowed: false,
      argSchema: { required: ["goal"] },
    });
  });
});
