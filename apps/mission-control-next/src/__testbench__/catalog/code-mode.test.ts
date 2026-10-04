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
    const check = findCheck(codeModeChecks, "code-mode.run");
    const ctx = makeTestContext();
    await expect(check.run(ctx)).resolves.toMatchObject({
      status: "pass",
      summary: "Run cm-1 completed; code artifact aaaaaaaaaaaa….",
    });
    expect(mocks.createCodeModeRun).toHaveBeenCalledWith({ language: "javascript", source: "return { ok: true };" });
    expect(mocks.resolveApproval).toHaveBeenCalledWith("appr-cm", "approve");
    expect(ctx.steps.map((step) => step.title)).toEqual(check.steps);
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

  it("fails naming the status when the run is rejected", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "rejected",
      codeHash: "h",
      codeArtifact: { sha256: SHA },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The run ended rejected.",
    );
  });

  it("fails when the finished run has no code hash", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "completed",
      codeArtifact: { sha256: SHA },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The run recorded no code hash.",
    );
  });

  it("fails when the code artifact SHA-256 is malformed", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "completed",
      codeHash: "h",
      codeArtifact: { sha256: "not-a-hash" },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The code artifact has no SHA-256.",
    );
  });

  it("is a host check", () => {
    expect(findCheck(codeModeChecks, "code-mode.run").tier).toBe("host");
  });
});
