import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeResult } from "@goatcitadel/contracts";
import {
  executeApprovedRemoteWorkerAction,
  type RemoteWorkerApprovedActionDependencies,
} from "./remote-worker-approved-action-runtime.js";
import type { RemoteWorkerApprovedActionInput } from "./remote-worker-effect-runtime.js";
import {
  executeApprovedExternalRuntimePendingAction,
  type ApprovedExternalRuntimePendingActionPort,
} from "./gateway/external-runtime-approval-adapter.js";

vi.mock("./gateway/external-runtime-approval-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway/external-runtime-approval-adapter.js")>()),
  executeApprovedExternalRuntimePendingAction: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  // The adapter is controlled here; storage and runtime handles must never be
  // reached after a failed fence. Real storage/dispatch is covered by the
  // existing remote-worker-effect-runtime tests through GatewayService.
  const dependencies = {
    coordinator: {
      prepareApprovedBuiltinBeforeExecute: vi.fn(),
      invokeApprovedMeshRuntime: vi.fn(),
      invokeApprovedMcpRuntime: vi.fn(),
      invokeApprovedExternalRuntimeTool: vi.fn(),
    },
    policyEngine: { executeApprovedAction: vi.fn() },
  } as unknown as RemoteWorkerApprovedActionDependencies;
  const input = {
    approvalId: "approval-fence",
    pending: { request: { toolName: "shell.exec", agentId: "agent", sessionId: "session", args: {} } },
    checkExecution: vi.fn(),
    signal: new AbortController().signal,
  } as unknown as RemoteWorkerApprovedActionInput;
  const result = { outcome: "executed" } as ToolInvokeResult;
  vi.mocked(executeApprovedExternalRuntimePendingAction).mockResolvedValue(result);
  return { dependencies, input, result };
}

describe("approved remote action execution fences", () => {
  it("refuses lost authority before preparing or dispatching", async () => {
    const f = fixture();
    vi.mocked(f.input.checkExecution).mockRejectedValue(new Error("revoked"));
    await expect(executeApprovedRemoteWorkerAction(f.dependencies, f.input)).rejects.toThrow("revoked");
    expect(f.dependencies.coordinator.prepareApprovedBuiltinBeforeExecute).not.toHaveBeenCalled();
    expect(executeApprovedExternalRuntimePendingAction).not.toHaveBeenCalled();
  });

  it.each(["builtin", "mcp", "mesh", "external"] as const)("rechecks authority before %s dispatch", async (kind) => {
    const f = fixture();
    let port!: ApprovedExternalRuntimePendingActionPort;
    vi.mocked(executeApprovedExternalRuntimePendingAction).mockImplementation(async (value) => {
      port = value;
      return f.result;
    });
    expect(await executeApprovedRemoteWorkerAction(f.dependencies, f.input)).toBe(f.result);
    vi.mocked(f.input.checkExecution).mockRejectedValue(new Error("revoked after preparation"));
    const request = { toolName: "shell.exec", agentId: "agent", sessionId: "session", args: {} };
    const markStarted = vi.fn();
    const dispatch =
      kind === "builtin"
        ? () =>
            port.executeApprovedAction(f.input.approvalId, f.input.signal, {
              deferResolution: true,
              externalRuntimeReplay: true,
            })
        : kind === "mcp"
          ? () => port.invokeApprovedMcpRuntime({ serverId: "server", toolName: "tool", arguments: {} }, markStarted)
          : kind === "mesh"
            ? () => port.invokeApprovedMeshRuntime!(request, f.result, f.input.approvalId, markStarted)
            : () => port.invokeApprovedExternalRuntimeTool(request, markStarted);
    await expect(dispatch()).rejects.toThrow("revoked after preparation");
    expect(markStarted).not.toHaveBeenCalled();
    expect(f.dependencies.policyEngine.executeApprovedAction).not.toHaveBeenCalled();
    expect(f.dependencies.coordinator.invokeApprovedMeshRuntime).not.toHaveBeenCalled();
    expect(f.dependencies.coordinator.invokeApprovedMcpRuntime).not.toHaveBeenCalled();
    expect(f.dependencies.coordinator.invokeApprovedExternalRuntimeTool).not.toHaveBeenCalled();
  });
});
