import { describe, expect, it } from "vitest";
import {
  parseCodeModeAiderAdapterResultEnvelope,
  parseCodeModeAiderPromotionRecord,
  parseCodeModeAiderWorkspacePin,
  withPromotedCodeModeAiderReplayPosture,
} from "./code-mode-aider-result-contract.js";

describe("code-mode-aider-result-contract", () => {
  it("accepts a governed non-replayable Aider patch envelope", () => {
    const envelope = parseCodeModeAiderAdapterResultEnvelope({
      contractVersion: 1,
      adapterId: "aider-cli-adapter",
      outcome: "patch_produced",
      runId: "run-1",
      repository: {
        rootRelPath: ".",
        baseRef: "abc123",
        headRef: "def456",
      },
      command: {
        argvRedacted: ["aider", "--yes", "[redacted prompt]"],
        cwdRelPath: ".",
        exitCode: 0,
        startedAt: "2026-05-31T00:00:00.000Z",
        finishedAt: "2026-05-31T00:00:01.000Z",
      },
      patchArtifact: {
        kind: "unified_diff",
        baseRef: "abc123",
        headRef: "def456",
        fileCount: 2,
        artifact: {
          artifactId: "patch-1",
          relPath: "code-mode/run-1/aider.patch",
          sha256: "patch-sha",
          bytes: 123,
          mimeType: "text/x-diff",
          createdAt: "2026-05-31T00:00:01.000Z",
        },
      },
      replay: {
        replaySafe: false,
        policy: "audit_only",
        reason: "Aider workspace mutation replay requires a separate side-effect runner.",
      },
    });

    expect(envelope.outcome).toBe("patch_produced");
    expect(envelope.replay).toMatchObject({ replaySafe: false, policy: "audit_only" });
  });

  it("rejects callable-looking or incomplete Aider envelopes", () => {
    expect(() =>
      parseCodeModeAiderAdapterResultEnvelope({
        contractVersion: 1,
        adapterId: "aider-cli-adapter",
        outcome: "patch_produced",
        command: { argvRedacted: ["aider"] },
        replay: {
          replaySafe: false,
          policy: "audit_only",
          reason: "missing patch",
        },
      }),
    ).toThrow("patch_produced outcome requires patchArtifact");

    expect(() =>
      parseCodeModeAiderAdapterResultEnvelope({
        contractVersion: 1,
        adapterId: "aider-cli-adapter",
        outcome: "no_changes",
        command: { argvRedacted: ["aider"] },
        replay: {
          replaySafe: true,
          policy: "live_replay",
          reason: "unsupported claim",
        },
      }),
    ).toThrow("replay posture must be audit_only and non-replayable");
  });

  const patchEnvelope = () => ({
    contractVersion: 1,
    adapterId: "aider-cli-adapter",
    outcome: "patch_produced",
    command: { argvRedacted: ["aider"] },
    patchArtifact: {
      kind: "unified_diff",
      artifact: {
        artifactId: "patch-1",
        relPath: "code-mode/run-1/aider.patch",
        sha256: "a".repeat(64),
        bytes: 1,
        mimeType: "text/x-diff",
        createdAt: "2026-05-31T00:00:01.000Z",
      },
    },
    replay: { replaySafe: false, policy: "audit_only", reason: "audit" },
  });
  const pin = {
    version: 1,
    sessionId: "session-1",
    worktreeIdentityHash: "b".repeat(64),
    worktreeHead: "c".repeat(40),
    worktreeStateHash: "d".repeat(64),
    capturedAt: "2026-05-31T00:00:02.000Z",
  };
  const record = (over: Record<string, unknown> = {}) => ({
    version: 1,
    status: "promoted",
    approvalId: "approval-1",
    patchArtifactId: "patch-1",
    patchSha256: "a".repeat(64),
    pin,
    startedAt: "2026-05-31T00:00:02.000Z",
    promotedAt: "2026-05-31T00:00:03.000Z",
    ...over,
  });
  const promotedEnvelope = () => ({
    ...patchEnvelope(),
    replay: { replaySafe: false, policy: "promoted", reason: "promoted" },
  });

  it("accepts promoted posture only with a matching promoted record", () => {
    const parsed = parseCodeModeAiderAdapterResultEnvelope(promotedEnvelope(), { promotion: record() });
    expect(parsed.replay.policy).toBe("promoted");
    const next = withPromotedCodeModeAiderReplayPosture(
      parseCodeModeAiderAdapterResultEnvelope(patchEnvelope()),
      parseCodeModeAiderPromotionRecord(record()),
    );
    expect(next.replay).toEqual({
      replaySafe: false,
      policy: "promoted",
      reason: "Patch promoted into the Chat workbench under approval approval-1; it is never re-applied.",
    });
  });

  it("rejects promoted posture without a promotion record", () => {
    expect(() => parseCodeModeAiderAdapterResultEnvelope(promotedEnvelope())).toThrow(/promoted/);
  });

  it("rejects promoted posture when the record names a different patch hash", () => {
    expect(() =>
      parseCodeModeAiderAdapterResultEnvelope(promotedEnvelope(), {
        promotion: record({ patchSha256: "e".repeat(64) }),
      }),
    ).toThrow(/patch/);
  });

  it("rejects audit_only posture paired with a promoted record", () => {
    expect(() => parseCodeModeAiderAdapterResultEnvelope(patchEnvelope(), { promotion: record() })).toThrow(
      /audit_only/,
    );
  });

  it("accepts audit_only posture with an applying intent", () => {
    const parsed = parseCodeModeAiderAdapterResultEnvelope(patchEnvelope(), {
      promotion: record({ status: "applying", promotedAt: undefined }),
    });
    expect(parsed.replay.policy).toBe("audit_only");
  });

  it("parseCodeModeAiderWorkspacePin rejects non-hex heads and missing sessions", () => {
    expect(parseCodeModeAiderWorkspacePin(pin)).toMatchObject({ sessionId: "session-1" });
    expect(() => parseCodeModeAiderWorkspacePin({ ...pin, worktreeHead: "zz" + "c".repeat(38) })).toThrow(
      /worktreeHead/,
    );
    expect(() => parseCodeModeAiderWorkspacePin({ ...pin, sessionId: "" })).toThrow(/sessionId/);
  });
});
