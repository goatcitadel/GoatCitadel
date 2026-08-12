import { describe, expect, it, vi } from "vitest";
import type { WorkspacePathBridgeSessionBinding } from "./workspace-path-bridge-integration.js";
import { ChatWorkspaceSnapshotService } from "./chat-workspace-snapshot-service.js";

const HASH = "a".repeat(64);
const binding = (): WorkspacePathBridgeSessionBinding => ({
  workspaceId: "workspace-1",
  project: {
    projectId: "project-1",
    revision: 4,
    workspaceId: "workspace-1",
    workspacePath: "projects/app",
    lifecycleStatus: "active",
  },
  gitIdentity: { required: true, expectedIdentitySha256: HASH },
});

function harness() {
  const resolveSessionBinding = vi.fn(async () => binding());
  const verifyWorkspacePath = vi.fn(async () => ({
    status: "verified" as const,
    snapshotId: "path-proof-1",
    canonicalCwd: "C:/workspace/projects/app",
    snapshotFingerprintSha256: "b".repeat(64),
    gitIdentitySha256: HASH,
  }));
  const runGit = vi.fn(async (_cwd: string, args: readonly string[]) => {
    const command = args.join(" ");
    if (command === "rev-parse --is-inside-work-tree") return "true\n";
    if (command === "rev-parse --verify HEAD") return `${"c".repeat(40)}\n`;
    if (command.startsWith("status ")) return " M src/a.ts\nM  src/b.ts\n";
    if (command.startsWith("symbolic-ref ")) return "main\n";
    if (command.startsWith("rev-list ")) return "2\t3\n";
    throw new Error("unexpected git call");
  });
  const service = new ChatWorkspaceSnapshotService({
    resolveSessionBinding,
    verifyWorkspacePath,
    runGit,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
  });
  return { service, resolveSessionBinding, verifyWorkspacePath, runGit };
}

const request = { capture: true as const, requestId: "snapshot-request-1" };
const captureInput = (sessionId = "session-1", turnId = "turn-1") => ({
  sessionId,
  turnId,
  workspaceId: "workspace-1",
  request,
});

describe("ChatWorkspaceSnapshotService", () => {
  it("captures bounded Git posture only after verified project/path binding", async () => {
    const { service, verifyWorkspacePath } = harness();
    const result = await service.capture(captureInput());

    expect(result).toMatchObject({
      status: "captured",
      workspaceId: "workspace-1",
      project: { projectId: "project-1", projectRevision: 4 },
      capturedAt: "2026-08-12T12:00:00.000Z",
      pathBinding: { verificationId: "path-proof-1", gitIdentitySha256: HASH },
      git: {
        branch: "main",
        trackedChangeCount: 2,
        untrackedChangeCount: 0,
        dirty: true,
        behind: 2,
        ahead: 3,
      },
    });
    expect(result).not.toHaveProperty("canonicalCwd");
    expect(JSON.stringify(result)).not.toContain("src/a.ts");
    expect(verifyWorkspacePath).toHaveBeenCalledWith(
      expect.objectContaining({ args: { cwd: "." }, sessionId: "session-1", workspaceId: "workspace-1" }),
      expect.objectContaining({ phase: "pre_execute" }),
    );
  });

  it("returns the exact cached record for repeated preflight/send resolution", async () => {
    const { service, runGit } = harness();
    const first = await service.capture(captureInput());
    const second = await service.capture(captureInput());
    expect(second).toBe(first);
    expect(runGit).toHaveBeenCalledTimes(5);
  });

  it("deduplicates concurrent capture and keeps snapshot identity session-scoped", async () => {
    const firstHarness = harness();
    const [first, duplicate] = await Promise.all([
      firstHarness.service.capture(captureInput()),
      firstHarness.service.capture(captureInput()),
    ]);
    const second = await firstHarness.service.capture(captureInput("session-2", "turn-1"));

    expect(duplicate).toBe(first);
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(firstHarness.runGit).toHaveBeenCalledTimes(10);
  });

  it("does not alias delimiter-bearing session and request identities", async () => {
    const { service, runGit } = harness();
    const first = await service.capture({
      ...captureInput("session:a", "turn-1"),
      request: { capture: true, requestId: "b" },
    });
    const second = await service.capture({
      ...captureInput("session", "turn-1"),
      request: { capture: true, requestId: "a:b" },
    });

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.requestId).toBe("a:b");
    expect(runGit).toHaveBeenCalledTimes(10);
  });

  it("shares preflight with its eventual turn but rejects reuse by another turn", async () => {
    const { service, runGit } = harness();
    const first = await service.capture(captureInput("session-1", "capability-preflight-draft"));
    const eventual = await service.capture(captureInput("session-1", "turn-1"));

    expect(eventual).toBe(first);
    await expect(service.capture(captureInput("session-1", "turn-2"))).rejects.toThrow(/already bound/i);
    expect(runGit).toHaveBeenCalledTimes(5);
  });

  it("evicts stale turn bindings together with bounded snapshot records", async () => {
    const { service } = harness();
    await service.capture(captureInput("session-1", "turn-1"));
    for (let index = 0; index < 256; index += 1) {
      await service.capture({
        ...captureInput("session-1", `turn-${index + 2}`),
        request: { capture: true, requestId: `snapshot-request-${index + 2}` },
      });
    }

    await expect(service.capture(captureInput("session-1", "turn-after-eviction"))).resolves.toMatchObject({
      requestId: request.requestId,
      status: "captured",
    });
  });

  it("renders missing project and failed path verification as unavailable", async () => {
    const unbound = harness();
    unbound.resolveSessionBinding.mockResolvedValue({ workspaceId: "workspace-1" });
    await expect(unbound.service.capture(captureInput())).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "project_unbound",
    });

    const blocked = harness();
    blocked.verifyWorkspacePath.mockResolvedValue({ status: "blocked", reasonCode: "git_identity_mismatch" });
    await expect(blocked.service.capture(captureInput())).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "path_verification_failed",
    });
  });

  it("maps binding and verifier exceptions to unavailable records", async () => {
    const bindingFailure = harness();
    bindingFailure.resolveSessionBinding.mockRejectedValueOnce(new Error("binding unavailable"));
    await expect(bindingFailure.service.capture(captureInput())).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "workspace_unavailable",
    });

    const verificationFailure = harness();
    verificationFailure.verifyWorkspacePath.mockRejectedValueOnce(new Error("verification unavailable"));
    await expect(verificationFailure.service.capture(captureInput())).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "path_verification_failed",
    });
  });

  it("fails closed when project identity changes during Git capture", async () => {
    const { service, resolveSessionBinding } = harness();
    resolveSessionBinding
      .mockResolvedValueOnce(binding())
      .mockResolvedValueOnce({ ...binding(), project: { ...binding().project!, revision: 5 } });
    await expect(service.capture(captureInput())).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "path_identity_changed",
    });
  });

  it("does not infer healthy repository state when Git is unavailable", async () => {
    const unavailable = harness();
    unavailable.runGit.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const result = await unavailable.service.capture(captureInput());
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "git_unavailable" });
    expect(result.git).toBeUndefined();
  });
});
