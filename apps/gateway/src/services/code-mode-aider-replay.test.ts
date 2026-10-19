import { describe, expect, it } from "vitest";
import type { CodeModeAiderReplayLink, CodeModeAiderWorkspacePin, CodeModeRunRecord } from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import {
  assertReplayPinUnchanged,
  prepareCodeModeAiderReplay,
  withCodeModeAiderReplayPreview,
} from "./code-mode-aider-replay.js";

const pin: CodeModeAiderWorkspacePin = {
  version: 1,
  sessionId: "session-1",
  worktreeIdentityHash: "a".repeat(64),
  worktreeHead: "b".repeat(40),
  worktreeStateHash: "c".repeat(64),
  capturedAt: "2026-10-18T00:00:00.000Z",
} as CodeModeAiderWorkspacePin;
const link: CodeModeAiderReplayLink = { runId: "run-original", policySnapshotHash: "d".repeat(64), workspacePin: pin };

function reasonOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictError);
    return (error as ConflictError).details?.reason as string | undefined;
  }
  return undefined;
}

describe("Aider replay helpers", () => {
  it("accepts the original pin and refuses every drift with a distinct reason", () => {
    expect(reasonOf(() => assertReplayPinUnchanged(link, { ...pin }))).toBeUndefined();
    expect(reasonOf(() => assertReplayPinUnchanged(link, undefined))).toBe("worktree_not_ready");
    expect(reasonOf(() => assertReplayPinUnchanged(link, { ...pin, worktreeIdentityHash: "e".repeat(64) }))).toBe(
      "worktree_identity_changed",
    );
    expect(reasonOf(() => assertReplayPinUnchanged(link, { ...pin, worktreeHead: "f".repeat(40) }))).toBe(
      "worktree_head_moved",
    );
    expect(reasonOf(() => assertReplayPinUnchanged(link, { ...pin, worktreeStateHash: "0".repeat(64) }))).toBe(
      "worktree_state_drift",
    );
  });

  it("adds the replay link to the approval preview only for replays", () => {
    expect(withCodeModeAiderReplayPreview(undefined, { runId: "run-new" })).toEqual({ runId: "run-new" });
    expect(withCodeModeAiderReplayPreview(link, { runId: "run-new" })).toEqual({
      runId: "run-new",
      replayOfRunId: "run-original",
      replayPinnedHead: pin.worktreeHead,
    });
  });

  it("refuses to replay a run that did not use the Aider adapter", async () => {
    const run = {
      runId: "run-native",
      status: "completed",
      executionBackend: { backendId: "best-effort-host" },
    } as unknown as CodeModeRunRecord;

    await expect(
      prepareCodeModeAiderReplay({ storage: {} as never, rootDir: ".", artifactRoot: "." }, run),
    ).rejects.toMatchObject({ details: { reason: "not_aider_run", runId: "run-native" } });
  });
});
