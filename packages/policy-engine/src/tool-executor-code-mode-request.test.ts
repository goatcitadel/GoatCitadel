import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { executeTool } from "./tool-executor.js";
import { CODE_MODE_REQUEST_TOOL_NAME } from "./tool-registry.js";

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
    toolName: CODE_MODE_REQUEST_TOOL_NAME,
    args: { goal: "read the text of saturday-plan.pdf", source: "return input.path;", input: { path: "plan.pdf" } },
    agentId: "assistant",
    sessionId: "session-1",
    turnId: "turn-1",
    ...overrides,
  };
}

describe("code_mode.request executor", () => {
  it("refuses without an approval id", async () => {
    const runCodeModeRequest = vi.fn(async () => ({ status: "completed" }));
    await expect(executeTool(request(), config, storage, { runCodeModeRequest })).rejects.toThrow(
      /requires an operator approval/,
    );
    await expect(
      executeTool(request({ approvedByApprovalId: "  " }), config, storage, { runCodeModeRequest }),
    ).rejects.toThrow(/requires an operator approval/);
    expect(runCodeModeRequest).not.toHaveBeenCalled();
  });

  it("calls runCodeModeRequest when approved", async () => {
    const hookResult = { runId: "code-run-1", status: "completed", result: { pages: 3 }, durationMs: 12 };
    const runCodeModeRequest = vi.fn(async () => hookResult);
    const approved = request({ approvedByApprovalId: "approval-1" });

    const result = await executeTool(approved, config, storage, { runCodeModeRequest });

    expect(runCodeModeRequest).toHaveBeenCalledTimes(1);
    expect(runCodeModeRequest).toHaveBeenCalledWith(expect.objectContaining({ approvedByApprovalId: "approval-1" }));
    expect(result).toMatchObject(hookResult);
  });

  it("rejects arguments outside the schema before calling the hook", async () => {
    const runCodeModeRequest = vi.fn(async () => ({ status: "completed" }));
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ goal: "", source: "return 1;" }, /goal/],
      [{ goal: "x".repeat(121), source: "return 1;" }, /goal/],
      [{ goal: "count", source: "x".repeat(20_001) }, /script/],
      [{ goal: "count", source: "return 1;", language: "python" }, /language/],
      [{ goal: "count", source: "return 1;", input: [] }, /input/],
      [{ goal: "count", source: "return 1;", reads: Array.from({ length: 11 }, (_, i) => `f${i}`) }, /reads/],
      [{ goal: "count", source: "return 1;", command: "rm" }, /does not accept/],
    ];
    for (const [args, message] of cases) {
      await expect(
        executeTool(request({ args, approvedByApprovalId: "approval-1" }), config, storage, { runCodeModeRequest }),
      ).rejects.toThrow(message);
    }
    expect(runCodeModeRequest).not.toHaveBeenCalled();
  });

  it("fails plainly when the runtime has no Code Mode hook", async () => {
    await expect(executeTool(request({ approvedByApprovalId: "approval-1" }), config, storage, {})).rejects.toThrow(
      "Code Mode requests are unavailable in this runtime.",
    );
  });
});
