import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  assertWorkspacePathBridgeSnapshot,
  type WorkspacePathBridgeSnapshotRecord,
} from "./workspace-path-bridge.js";

function buildSnapshot(overrides: Partial<WorkspacePathBridgeSnapshotRecord> = {}): WorkspacePathBridgeSnapshotRecord {
  return {
    schemaVersion: WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
    snapshotId: "path-bridge-1",
    requestHash: "a".repeat(64),
    workspaceId: "workspace-1",
    inputFlavor: "windows_native",
    targetFlavor: "msys",
    gitIdentityRequired: false,
    inputPathHash: "b".repeat(64),
    allowedRootsHash: "c".repeat(64),
    canonicalHostPath: "F:\\code\\personal-ai",
    canonicalTargetPath: "/f/code/personal-ai",
    roundTrip: {
      attempted: true,
      converter: "native",
      inputHostPathSha256: "d".repeat(64),
      targetPathSha256: "e".repeat(64),
      roundTripHostPathSha256: "d".repeat(64),
      equal: true,
    },
    gitIdentity: { status: "not_repository" },
    status: "verified",
    callable: true,
    snapshotSha256: "f".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("workspace path bridge contracts", () => {
  it("allows a verified non-repository mapping only when Git identity is optional", () => {
    expect(() => assertWorkspacePathBridgeSnapshot(buildSnapshot())).not.toThrow();
    expect(() => assertWorkspacePathBridgeSnapshot(buildSnapshot({ gitIdentityRequired: true }))).toThrow(
      /Git identity|incomplete/u,
    );
  });

  it("requires blocked and unavailable evidence to remain non-callable", () => {
    const blocked = buildSnapshot({
      canonicalHostPath: undefined,
      canonicalTargetPath: undefined,
      roundTrip: { attempted: false, converter: "native", equal: false },
      gitIdentity: { status: "failed" },
      status: "blocked",
      reasonCode: "invalid_path",
      callable: false,
    });
    expect(() => assertWorkspacePathBridgeSnapshot(blocked)).not.toThrow();
    expect(() => assertWorkspacePathBridgeSnapshot({ ...blocked, callable: true })).toThrow(/cannot be callable/u);
    expect(() =>
      assertWorkspacePathBridgeSnapshot({ ...blocked, status: "unavailable", reasonCode: "invalid_path" }),
    ).toThrow(/invalid reason/u);
  });

  it("rejects WSL distro drift and unknown evidence fields", () => {
    expect(() => assertWorkspacePathBridgeSnapshot(buildSnapshot({ inputFlavor: "wsl" }))).toThrow(/distro evidence/u);
    expect(() => assertWorkspacePathBridgeSnapshot({ ...buildSnapshot(), browserTrusted: true } as never)).toThrow(
      /unsupported or missing fields/u,
    );
  });
});
