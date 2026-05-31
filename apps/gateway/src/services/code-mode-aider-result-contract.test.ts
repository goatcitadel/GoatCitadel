import { describe, expect, it } from "vitest";
import { parseCodeModeAiderAdapterResultEnvelope } from "./code-mode-aider-result-contract.js";

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
});
