import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { PermissionProfileRepository } from "./permission-profile-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

describe("PermissionProfileRepository", () => {
  it("ships safe and trusted local built-ins and activates custom profiles by surface", () => {
    const { repo } = createStore();

    const builtins = repo.listProfiles();
    assert.equal(builtins.find((profile) => profile.profileId === "safe")?.approvalMode, "approve_all");
    assert.equal(builtins.find((profile) => profile.profileId === "trusted_local_power")?.approvalMode, "bypass");
    assert.equal(builtins.find((profile) => profile.profileId === "scheduled-restricted")?.builtin, true);
    assert.equal(builtins.find((profile) => profile.profileId === "heartbeat-restricted")?.builtin, true);

    const custom = repo.createProfile({
      label: "Code Review",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      toolPatterns: ["session.status", "docs.search"],
      createdBy: "operator-a",
    });

    repo.activateProfile({
      profileId: custom.profileId,
      workspaceId: "workspace-a",
      surface: "code",
      createdBy: "operator-a",
    });

    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        surface: "code",
      }).permissionProfile.profileId,
      custom.profileId,
    );
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-b",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        surface: "code",
      }).permissionProfile.profileId,
      custom.profileId,
    );
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        surface: "chat",
      }).permissionProfile.profileId,
      "safe",
    );
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        profileId: custom.profileId,
      }).permissionProfile.profileId,
      custom.profileId,
    );
    assert.throws(
      () =>
        repo.resolveContext({
          operatorId: "operator-a",
          workspaceId: "workspace-b",
          profileId: custom.profileId,
        }),
      /not active for the requested operator\/workspace\/session scope/,
    );
    assert.throws(
      () =>
        repo.activateProfile({
          profileId: custom.profileId,
          operatorId: "operator-a",
          workspaceId: "workspace-b",
          surface: "code",
          createdBy: "operator-a",
        }),
      /cannot be activated outside its workspace scope/,
    );
    assert.throws(
      () =>
        repo.createProfile({
          label: "Global custom",
          scope: "global" as never,
          approvalMode: "bypass",
          createdBy: "operator-a",
        }),
      /Custom permission profiles cannot use global scope/,
    );
  });

  it("updates a custom profile with only parameters owned by the update statement", () => {
    const { repo } = createStore();
    const custom = repo.createProfile({
      label: "Initial profile",
      description: "Before update",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_all",
      toolPatterns: ["session.status"],
      createdBy: "operator-a",
    });

    const updated = repo.updateProfile(custom.profileId, {
      label: "Updated profile",
      description: "After update",
      approvalMode: "approve_risky",
      toolPatterns: ["session.status", "fs.write"],
      allow: ["fs.*"],
      deny: ["fs.write"],
      readAccessMode: "roots_only",
      defaultForSurfaces: ["chat", "tools"],
      updatedBy: "operator-a",
    });

    assert.equal(updated.label, "Updated profile");
    assert.equal(updated.description, "After update");
    assert.equal(updated.approvalMode, "approve_risky");
    assert.deepEqual(updated.toolPatterns, ["session.status", "fs.write"]);
    assert.deepEqual(updated.allow, ["fs.*"]);
    assert.deepEqual(updated.deny, ["fs.write"]);
    assert.equal(updated.readAccessMode, "roots_only");
    assert.deepEqual(updated.defaultForSurfaces, ["chat", "tools"]);
    assert.equal(updated.builtin, false);
  });

  it("does not let stored rows shadow builtin restricted permission profiles", () => {
    const { db, repo } = createStore();
    db.prepare(
      `
      INSERT INTO permission_profiles (
        profile_id, label, description, builtin, status, scope, scope_ref, approval_mode, legacy_tool_profile,
        tool_patterns_json, allow_json, deny_json, read_access_mode, default_for_surfaces_json,
        created_by, created_at, updated_at, archived_at
      ) VALUES (
        @profileId, @label, NULL, 0, 'active', 'operator', 'operator-a', 'bypass', NULL,
        '["*"]', '["*"]', '[]', 'full_disk', '[]',
        'operator-a', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z', NULL
      )
    `,
    ).run({ profileId: "scheduled-restricted", label: "Stored Shadow" });

    const scheduledProfiles = repo.listProfiles(true).filter((profile) => profile.profileId === "scheduled-restricted");

    assert.equal(scheduledProfiles.length, 1);
    const scheduledProfile = scheduledProfiles[0];
    assert.ok(scheduledProfile);
    assert.equal(scheduledProfile.builtin, true);
    assert.equal(scheduledProfile.label, "Scheduled (Restricted)");
  });

  it("reconciles active profile activations for exact owner context", () => {
    const { repo } = createStore();
    const custom = repo.createProfile({
      label: "Workspace Code",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      defaultForSurfaces: ["code", "chat"],
      createdBy: "operator-a",
    });

    repo.activateProfile({
      profileId: custom.profileId,
      workspaceId: "workspace-a",
      surface: "code",
      createdBy: "operator-a",
    });
    repo.activateProfile({
      profileId: custom.profileId,
      workspaceId: "workspace-a",
      surface: "chat",
      createdBy: "operator-a",
    });

    assert.equal(
      repo.deactivateProfileActivations({
        profileId: custom.profileId,
        workspaceId: "workspace-a",
      }),
      2,
    );
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        surface: "code",
      }).permissionProfile.profileId,
      "safe",
    );
  });

  it("clears stale surface activations when a profile is activated for all surfaces", () => {
    const { repo } = createStore();
    const chatProfile = repo.createProfile({
      label: "Chat Only",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      createdBy: "operator-a",
    });
    const allProfile = repo.createProfile({
      label: "All Surfaces",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "bypass",
      createdBy: "operator-a",
    });

    repo.activateProfile({
      profileId: chatProfile.profileId,
      workspaceId: "workspace-a",
      surface: "chat",
      createdBy: "operator-a",
    });
    repo.activateProfile({
      profileId: allProfile.profileId,
      workspaceId: "workspace-a",
      surface: "all",
      createdBy: "operator-a",
    });

    assert.equal(
      repo.resolveContext({ operatorId: "operator-a", workspaceId: "workspace-a", surface: "chat" }).permissionProfile
        .profileId,
      allProfile.profileId,
    );
    assert.equal(
      repo.resolveContext({ operatorId: "operator-a", workspaceId: "workspace-a", surface: "code" }).permissionProfile
        .profileId,
      allProfile.profileId,
    );
  });

  it("rolls back activation replacement when its owning transaction fails", () => {
    const { db, repo } = createStore();
    const original = repo.createProfile({
      label: "Original Chat",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      createdBy: "operator-a",
    });
    const replacement = repo.createProfile({
      label: "Replacement Chat",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_all",
      createdBy: "operator-a",
    });
    repo.activateProfile({
      profileId: original.profileId,
      workspaceId: "workspace-a",
      surface: "chat",
      createdBy: "operator-a",
    });

    assert.throws(
      () =>
        db.transaction("immediate", () => {
          repo.activateProfile({
            profileId: replacement.profileId,
            workspaceId: "workspace-a",
            surface: "chat",
            createdBy: "operator-a",
          });
          throw new Error("activation projection failed");
        }),
      /activation projection failed/,
    );

    assert.equal(
      repo.resolveContext({ operatorId: "operator-a", workspaceId: "workspace-a", surface: "chat" }).permissionProfile
        .profileId,
      original.profileId,
    );
  });

  it("matches explicit and scoped local operator overrides and expires them", () => {
    const { repo } = createStore();

    const workspaceOverride = repo.createLocalOperatorOverride({
      operatorId: "operator-a",
      scope: "workspace",
      scopeRef: "workspace-a",
      reason: "release verification",
      ttlSeconds: 60,
      createdBy: "operator-a",
    });
    assert.equal(
      repo.resolveContext({ operatorId: "operator-a", workspaceId: "workspace-a" }).localOperatorOverride?.overrideId,
      workspaceOverride.overrideId,
    );
    assert.equal(
      repo.resolveContext({ operatorId: "operator-b", workspaceId: "workspace-a" }).localOperatorOverride?.overrideId,
      undefined,
    );
    assert.throws(
      () =>
        repo.resolveContext({
          operatorId: "operator-b",
          workspaceId: "workspace-a",
          overrideId: workspaceOverride.overrideId,
        }),
      /not active for the requested operator\/workspace\/session\/run scope/,
    );
    assert.throws(
      () =>
        repo.createLocalOperatorOverride({
          operatorId: "operator-a",
          scope: "run",
          reason: "missing target",
          ttlSeconds: 60,
          createdBy: "operator-a",
        }),
      /scopeRef/,
    );

    const runOverride = repo.createLocalOperatorOverride({
      operatorId: "operator-a",
      scope: "run",
      scopeRef: "run-a",
      reason: "focused code mode run",
      ttlSeconds: 60,
      createdBy: "operator-a",
    });
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-b",
        sessionId: "session-b",
        runId: "run-a",
      }).localOperatorOverride?.overrideId,
      runOverride.overrideId,
    );
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-b",
        sessionId: "session-b",
        taskId: "run-a",
      }).localOperatorOverride?.overrideId,
      undefined,
    );

    assert.equal(
      repo.revokeLocalOperatorOverride(runOverride.overrideId, "2026-05-17T20:10:00.000Z", "operator-1"),
      true,
    );
    assert.equal(repo.getLocalOperatorOverride(runOverride.overrideId).revokedBy, "operator-1");
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-b",
        sessionId: "session-b",
        runId: "run-a",
      }).localOperatorOverride?.overrideId,
      undefined,
    );
  });

  it("prefers the most specific matching local operator override", () => {
    const { repo } = createStore();

    const runOverride = repo.createLocalOperatorOverride(
      {
        operatorId: "operator-a",
        scope: "run",
        scopeRef: "run-a",
        reason: "narrow run override",
        ttlSeconds: 60,
        createdBy: "operator-a",
      },
      "2099-05-17T20:00:00.000Z",
    );
    assert.ok(Math.abs(Date.parse(runOverride.createdAt) - Date.now()) < 5_000);
    assert.ok(Math.abs(Date.parse(runOverride.expiresAt) - Date.parse(runOverride.createdAt) - 60_000) < 1_000);
    repo.createLocalOperatorOverride(
      {
        operatorId: "operator-a",
        scope: "operator",
        reason: "broader later operator override",
        ttlSeconds: 600,
        createdBy: "operator-a",
      },
      "2099-05-17T20:01:00.000Z",
    );

    assert.equal(
      repo.resolveContext({
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        runId: "run-a",
      }).localOperatorOverride?.overrideId,
      runOverride.overrideId,
    );
    assert.ok(repo.listActiveLocalOperatorOverrides("1900-01-01T00:00:00.000Z").length >= 2);
    assert.ok(repo.listActiveLocalOperatorOverrides("2999-01-01T00:00:00.000Z").length >= 2);
  });

  it("fails closed for malformed override expiry and invalid TTL inputs", () => {
    const { db, repo } = createStore();
    assert.throws(
      () =>
        repo.createLocalOperatorOverride({
          operatorId: "operator-a",
          scope: "operator",
          reason: "invalid ttl",
          ttlSeconds: Number.NaN,
          createdBy: "operator-a",
        }),
      /ttlSeconds/,
    );
    const override = repo.createLocalOperatorOverride({
      operatorId: "operator-a",
      scope: "operator",
      reason: "malformed persisted expiry",
      ttlSeconds: 60,
      createdBy: "operator-a",
    });
    db.prepare("UPDATE local_operator_overrides SET expires_at = 'malformed' WHERE override_id = ?").run(
      override.overrideId,
    );

    assert.equal(
      repo.listActiveLocalOperatorOverrides().some((record) => record.overrideId === override.overrideId),
      false,
    );
    assert.equal(repo.getLocalOperatorOverride(override.overrideId).status, "expired");
  });

  it("falls back to the provided defaultProfileId when no profile or activation resolves", () => {
    const { repo } = createStore();

    // No explicit profileId and no matching activation: the built-in fallback is "safe".
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-z",
        workspaceId: "workspace-z",
        sessionId: "session-z",
        surface: "cowork",
      }).permissionProfile.profileId,
      "safe",
    );

    // Same context with a caller-supplied default (the gateway's local + bypass case)
    // flips the fallback to the bypass built-in instead of approve-all "safe".
    const resolved = repo.resolveContext({
      operatorId: "operator-z",
      workspaceId: "workspace-z",
      sessionId: "session-z",
      surface: "cowork",
      defaultProfileId: "trusted_local_power",
    });
    assert.equal(resolved.permissionProfile.profileId, "trusted_local_power");
    assert.equal(resolved.permissionProfile.approvalMode, "bypass");
  });

  it("prefers an explicit activation over defaultProfileId (default only changes the fallback)", () => {
    const { repo } = createStore();

    const custom = repo.createProfile({
      label: "Cowork Approve",
      scope: "workspace",
      scopeRef: "workspace-act",
      approvalMode: "approve_all",
      toolPatterns: ["*"],
      createdBy: "operator-act",
    });
    repo.activateProfile({
      profileId: custom.profileId,
      workspaceId: "workspace-act",
      surface: "cowork",
      createdBy: "operator-act",
    });

    // A matching activation wins even when a bypass default is supplied.
    assert.equal(
      repo.resolveContext({
        operatorId: "operator-act",
        workspaceId: "workspace-act",
        sessionId: "session-act",
        surface: "cowork",
        defaultProfileId: "trusted_local_power",
      }).permissionProfile.profileId,
      custom.profileId,
    );
  });
});

function createStore(): { db: DatabaseClient; repo: PermissionProfileRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-permission-profile-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new PermissionProfileRepository(db) };
}
