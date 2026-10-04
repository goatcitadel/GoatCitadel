import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { codeModeChecks } from "./code-mode";

const mocks = vi.hoisted(() => ({ createCodeModeRun: vi.fn(), fetchCodeModeRun: vi.fn(), resolveApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  createCodeModeRun: mocks.createCodeModeRun,
  fetchCodeModeRun: mocks.fetchCodeModeRun,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ resolveApproval: mocks.resolveApproval }));

const SHA = "a".repeat(64);

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createCodeModeRun.mockResolvedValue({ runId: "cm-1", status: "approval_pending", approvalId: "appr-cm" });
  mocks.resolveApproval.mockResolvedValue({ approval: { status: "approved" } });
});

describe("Code Mode run", () => {
  it("approves the run, waits for it to finish, and checks the artifact hash", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "completed",
      codeHash: "h",
      codeArtifact: { sha256: SHA },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Run cm-1 completed; code artifact aaaaaaaaaaaa….",
    });
    expect(mocks.createCodeModeRun).toHaveBeenCalledWith({ language: "javascript", source: "return { ok: true };" });
    expect(mocks.resolveApproval).toHaveBeenCalledWith("appr-cm", "approve");
  });

  it("fails when the run does not wait for approval", async () => {
    mocks.createCodeModeRun.mockResolvedValueOnce({ runId: "cm-1", status: "queued" });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "did not wait for approval",
    );
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("fails when the run ends failed", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "failed",
      error: "guest error",
      codeHash: "h",
      codeArtifact: { sha256: SHA },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The run ended failed: guest error.",
    );
  });

  it("is a host check", () => {
    expect(findCheck(codeModeChecks, "code-mode.run").tier).toBe("host");
  });
});
