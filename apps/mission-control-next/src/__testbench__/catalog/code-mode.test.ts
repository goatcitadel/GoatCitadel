import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { codeModeChecks } from "./code-mode";

const mocks = vi.hoisted(() => ({ createCodeModeRun: vi.fn(), fetchCodeModeRun: vi.fn(), resolveApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  createCodeModeRun: mocks.createCodeModeRun,
  fetchCodeModeRun: mocks.fetchCodeModeRun,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ resolveApproval: mocks.resolveApproval }));

// SHA-256 of the fixed snippet `return { ok: true };`.
const SHA = "2afa6c5e563288763723bf1da774a33173023b84fb7acf26c4dfab1222225923";

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
      codeHash: SHA,
      codeArtifact: { sha256: SHA },
    });
    const check = findCheck(codeModeChecks, "code-mode.run");
    const ctx = makeTestContext();
    await expect(check.run(ctx)).resolves.toMatchObject({
      status: "pass",
      summary: "Run cm-1 completed; code artifact 2afa6c5e5632….",
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
      codeHash: SHA,
      codeArtifact: { sha256: SHA },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The run ended failed: guest error.",
    );
  });

  it("is blocked, not failed, when the gateway fails closed for lack of an isolation runner", async () => {
    const sandbox = { required: true, available: false, checksFailed: ["best_effort_host_disabled"] };
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "failed",
      error: "Code Mode sandbox failed closed on win32: best_effort_host_disabled.",
      codeHash: SHA,
      codeArtifact: { sha256: SHA },
      sandbox,
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).resolves.toEqual({
      status: "blocked",
      summary:
        "No usable Code Mode isolation runner on this machine (best_effort_host_disabled); the gateway failed closed as designed.",
      evidence: sandbox,
    });
  });

  it("still fails a failed run whose isolation runner was available", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "failed",
      error: "guest error",
      codeHash: SHA,
      codeArtifact: { sha256: SHA },
      sandbox: { required: true, available: true, checksFailed: [] },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The run ended failed: guest error.",
    );
  });

  it("fails naming the status when the run is rejected", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "rejected",
      codeHash: SHA,
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
      "The run's code hash is not the SHA-256 of the approved snippet.",
    );
  });

  it("fails when the code hash is a well-formed hash of other code", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "completed",
      codeHash: "b".repeat(64),
      codeArtifact: { sha256: SHA },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The run's code hash is not the SHA-256 of the approved snippet.",
    );
  });

  it("fails when the stored code artifact is not the approved snippet", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({
      runId: "cm-1",
      status: "completed",
      codeHash: SHA,
      codeArtifact: { sha256: "c".repeat(64) },
    });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "The stored code artifact is not the snippet that was approved.",
    );
  });

  it("is a host check", () => {
    expect(findCheck(codeModeChecks, "code-mode.run").tier).toBe("host");
  });
});
