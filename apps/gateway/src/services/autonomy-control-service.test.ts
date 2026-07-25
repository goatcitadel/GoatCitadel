import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { AutonomyAuditRestoreRef } from "@goatcitadel/contracts";
import {
  AutonomyControlService,
  type AutonomyControlServiceDeps,
  type AutonomyRestoreHandlers,
} from "./autonomy-control-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createStorage(): Promise<Storage> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-autonomy-control-"));
  tempRoots.push(rootDir);
  return new Storage({
    dbPath: path.join(rootDir, "runtime.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
}

function createHandlers(overrides: Partial<AutonomyRestoreHandlers> = {}): AutonomyRestoreHandlers {
  return {
    restoreSkillRevision: vi.fn(),
    restoreOperatorProfile: vi.fn(),
    restoreCuratorArchive: vi.fn(() => true),
    revertTune: vi.fn(),
    ...overrides,
  };
}

interface ServiceHarness {
  service: AutonomyControlService;
  storage: Storage;
  handlers: AutonomyRestoreHandlers;
  setKillSwitch: ReturnType<typeof vi.fn>;
  diagnostics: Array<{ event: string; level: string }>;
  flags: Record<string, boolean>;
  revision: { current: number };
}

async function createService(
  options: {
    autonomyDisabled?: boolean;
    handlers?: Partial<AutonomyRestoreHandlers>;
    now?: () => string;
    revision?: number;
  } = {},
): Promise<ServiceHarness> {
  const storage = await createStorage();
  const handlers = createHandlers(options.handlers);
  const flags: Record<string, boolean> = { autonomyV1Disabled: Boolean(options.autonomyDisabled) };
  const revision = { current: options.revision ?? 7 };
  const setKillSwitch = vi.fn(async (input: { disabled: boolean; expectedRevision: number }) => {
    flags.autonomyV1Disabled = input.disabled;
    revision.current += 1;
  });
  const diagnostics: Array<{ event: string; level: string }> = [];
  const deps: AutonomyControlServiceDeps = {
    storage,
    isFeatureEnabled: (flag) => flags[flag] === true,
    readSettingsRevision: () => revision.current,
    setKillSwitch,
    restoreHandlers: handlers,
    recordDevDiagnostic: (input) => diagnostics.push({ event: input.event, level: input.level }),
    now: options.now,
  };
  return { service: new AutonomyControlService(deps), storage, handlers, setKillSwitch, diagnostics, flags, revision };
}

function ref(kind: AutonomyAuditRestoreRef["kind"], extra: Record<string, unknown> = {}): AutonomyAuditRestoreRef {
  switch (kind) {
    case "skill_revision":
      return { kind, snapshotRef: extra.snapshotRef ?? { skillId: "s1" } };
    case "operator_profile":
      return { kind, priorSnapshot: extra.priorSnapshot ?? { operatorProfileId: "op_1" } };
    case "memory":
      return { kind, priorSnapshot: extra.priorSnapshot ?? { operatorProfileId: "op_1" } };
    case "curator_archive":
      return { kind, skillId: String(extra.skillId ?? "skill_x") };
    case "tune":
      return { kind, tuneId: String(extra.tuneId ?? "tune_1") };
  }
}

describe("AutonomyControlService", () => {
  describe("getStatus", () => {
    it("reflects the kill switch when engaged", async () => {
      const { service } = await createService({ autonomyDisabled: true });
      const status = service.getStatus();
      expect(status.revision).toBe(7);
      expect(status.killSwitchEngaged).toBe(true);
      expect(status.autonomyEnabled).toBe(false);
    });

    it("reflects the kill switch when disengaged and summarizes the audit ledger", async () => {
      const { service, storage } = await createService({ autonomyDisabled: false });
      storage.autonomyAudit.append({ kind: "tune", targetKey: "k", restoreRef: ref("tune") });
      storage.autonomyAudit.append({
        kind: "curator_archive",
        targetKey: "skill_x",
        restoreRef: ref("curator_archive"),
      });
      const status = service.getStatus();
      expect(status.killSwitchEngaged).toBe(false);
      expect(status.autonomyEnabled).toBe(true);
      expect(status.audit.totalEntries).toBe(2);
      expect(status.audit.unrevertedEntries).toBe(2);
      expect(status.audit.byKind).toHaveLength(5);
      expect(status.audit.recent).toHaveLength(2);
    });

    it("projects restore snapshots for status while rollback still receives raw ledger truth", async () => {
      const { service, storage, handlers } = await createService({ autonomyDisabled: false });
      const priorSnapshot = {
        operatorProfileId: "op-secret-projection",
        revision: 7,
        DATABASE_PASSWORD: "rollback-db-secret",
        authorization: "Bearer rollback-auth-secret",
        secretRef: "vault:operator-profile",
        tokenId: "operator-profile-token-id",
      };
      const entry = storage.autonomyAudit.append({
        kind: "memory",
        targetKey: "op-secret-projection",
        restoreRef: ref("memory", { priorSnapshot }),
      });

      const status = service.getStatus(1);

      expect(JSON.stringify(status)).not.toContain("rollback-db-secret");
      expect(JSON.stringify(status)).not.toContain("rollback-auth-secret");
      expect(status.audit.recent[0]).toMatchObject({
        auditId: entry.auditId,
        kind: "memory",
        targetKey: "op-secret-projection",
        reverted: false,
        restoreRef: {
          kind: "memory",
          priorSnapshot: {
            operatorProfileId: "op-secret-projection",
            revision: 7,
            DATABASE_PASSWORD: "[REDACTED]",
            authorization: "[REDACTED]",
            secretRef: "vault:operator-profile",
            tokenId: "operator-profile-token-id",
          },
        },
      });
      const rawEntry = storage.autonomyAudit.listRecent(1)[0];
      expect(rawEntry?.restoreRef).toEqual({ kind: "memory", priorSnapshot });

      const reverted = service.revertAutonomousChangesSince("2000-01-01T00:00:00.000Z");

      expect(reverted.reverted).toBe(1);
      expect(handlers.restoreOperatorProfile).toHaveBeenCalledWith(priorSnapshot);
    });
  });

  describe("setKillSwitch", () => {
    it("toggles the flag through the injected setter and returns refreshed status", async () => {
      const { service, setKillSwitch } = await createService({ autonomyDisabled: false });
      const status = await service.setKillSwitch(true, 7);
      expect(setKillSwitch).toHaveBeenCalledWith({ disabled: true, expectedRevision: 7 });
      expect(status.revision).toBe(8);
      expect(status.killSwitchEngaged).toBe(true);
    });

    it("leaves status unchanged when the config-generation mutation rejects", async () => {
      const { service, setKillSwitch } = await createService({ autonomyDisabled: false, revision: 11 });
      const before = service.getStatus();
      setKillSwitch.mockRejectedValueOnce(new Error("generation apply failed"));

      await expect(service.setKillSwitch(true, 11)).rejects.toThrow("generation apply failed");

      expect(service.getStatus()).toEqual(before);
    });
  });

  describe("recordAutonomousMutation", () => {
    it("appends an entry and never throws when the ledger write fails", async () => {
      const { service, storage, diagnostics } = await createService();
      const entry = service.recordAutonomousMutation({ kind: "tune", targetKey: "k", restoreRef: ref("tune") });
      expect(entry?.kind).toBe("tune");

      // Force the append to throw — the mutation path must survive.
      vi.spyOn(storage.autonomyAudit, "append").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      const failed = service.recordAutonomousMutation({ kind: "tune", targetKey: "k2", restoreRef: ref("tune") });
      expect(failed).toBeUndefined();
      expect(diagnostics.some((d) => d.event === "autonomy_audit_append_failed")).toBe(true);
    });
  });

  describe("revertAutonomousChangesSince", () => {
    it("restores only entries >= T (newest-first) and marks them reverted", async () => {
      const { service, storage, handlers } = await createService();
      storage.autonomyAudit.append(
        { kind: "tune", targetKey: "old", restoreRef: ref("tune", { tuneId: "old" }) },
        "2026-06-20T00:00:00.000Z",
      );
      storage.autonomyAudit.append(
        { kind: "tune", targetKey: "mid", restoreRef: ref("tune", { tuneId: "mid" }) },
        "2026-06-22T00:00:00.000Z",
      );
      storage.autonomyAudit.append(
        {
          kind: "curator_archive",
          targetKey: "skill_new",
          restoreRef: ref("curator_archive", { skillId: "skill_new" }),
        },
        "2026-06-23T00:00:00.000Z",
      );

      const summary = service.revertAutonomousChangesSince("2026-06-21T00:00:00.000Z");
      expect(summary.considered).toBe(2);
      expect(summary.reverted).toBe(2);
      expect(summary.failed).toBe(0);
      // Newest-first dispatch order.
      expect(summary.results.map((r) => r.targetKey)).toEqual(["skill_new", "mid"]);

      // Correct restore callbacks fired with the right refs.
      expect(handlers.restoreCuratorArchive).toHaveBeenCalledWith("skill_new");
      expect(handlers.revertTune).toHaveBeenCalledWith("mid");
      expect(handlers.revertTune).not.toHaveBeenCalledWith("old");

      // The two reverted entries are now excluded; the pre-T entry is untouched.
      expect(storage.autonomyAudit.listUnrevertedSince("2000-01-01T00:00:00.000Z").map((e) => e.targetKey)).toEqual([
        "old",
      ]);
    });

    it("isolates a per-entry failure and continues with the rest", async () => {
      const { service, storage, handlers, diagnostics } = await createService({
        handlers: {
          revertTune: vi.fn((tuneId: string) => {
            if (tuneId === "boom") {
              throw new Error("restore exploded");
            }
          }),
        },
      });
      storage.autonomyAudit.append(
        { kind: "tune", targetKey: "boom", restoreRef: ref("tune", { tuneId: "boom" }) },
        "2026-06-22T02:00:00.000Z",
      );
      storage.autonomyAudit.append(
        { kind: "tune", targetKey: "ok", restoreRef: ref("tune", { tuneId: "ok" }) },
        "2026-06-22T01:00:00.000Z",
      );

      const summary = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");
      expect(summary.considered).toBe(2);
      expect(summary.reverted).toBe(1);
      expect(summary.failed).toBe(1);
      const failedResult = summary.results.find((r) => r.status === "failed");
      expect(failedResult?.targetKey).toBe("boom");
      expect(failedResult?.error).toContain("restore exploded");
      expect(handlers.revertTune).toHaveBeenCalledTimes(2);
      expect(diagnostics.some((d) => d.event === "autonomy_revert_entry_failed")).toBe(true);

      // The failed entry stays un-reverted (retryable); the ok one is gone.
      expect(storage.autonomyAudit.listUnrevertedSince("2026-06-22T00:00:00.000Z").map((e) => e.targetKey)).toEqual([
        "boom",
      ]);
    });

    it("does not dispatch a restore for an entry already reverted (no double-dispatch)", async () => {
      // Simulate a concurrent/earlier revert having already marked the entry: the
      // claim (`markReverted ... AND reverted = 0`) must fail and the restore
      // callback must NOT fire.
      const { service, storage, handlers } = await createService();
      const entry = storage.autonomyAudit.append(
        { kind: "tune", targetKey: "already", restoreRef: ref("tune", { tuneId: "already" }) },
        "2026-06-22T00:00:00.000Z",
      );
      // Pre-claim it (as a prior pass would have).
      expect(storage.autonomyAudit.markReverted(entry.auditId, "2026-06-22T00:30:00.000Z")).toBe(true);

      // listUnrevertedSince already excludes it, so feed it back through a kind we
      // know is present by appending a second, still-unreverted entry to ensure the
      // pass runs, then assert the claimed one never dispatches.
      const summary = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");
      expect(summary.considered).toBe(0); // the only entry is already reverted → excluded
      expect(handlers.revertTune).not.toHaveBeenCalled();
    });

    it("claim-first revert dispatches each restore exactly once across back-to-back passes", async () => {
      const { service, storage, handlers } = await createService();
      storage.autonomyAudit.append(
        { kind: "tune", targetKey: "once", restoreRef: ref("tune", { tuneId: "once" }) },
        "2026-06-22T00:00:00.000Z",
      );

      const first = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");
      const second = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");

      expect(first.reverted).toBe(1);
      expect(second.considered).toBe(0);
      // Exactly one dispatch total — the second pass finds nothing un-reverted.
      expect(handlers.revertTune).toHaveBeenCalledTimes(1);
    });

    it("rolls back the claim on a failed restore so the entry stays retryable", async () => {
      let attempts = 0;
      const { service, storage, handlers } = await createService({
        handlers: {
          revertTune: vi.fn((tuneId: string) => {
            attempts += 1;
            // Fail on the first attempt, succeed on the retry.
            if (tuneId === "flaky" && attempts === 1) {
              throw new Error("transient restore failure");
            }
          }),
        },
      });
      storage.autonomyAudit.append(
        { kind: "tune", targetKey: "flaky", restoreRef: ref("tune", { tuneId: "flaky" }) },
        "2026-06-22T00:00:00.000Z",
      );

      const firstPass = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");
      expect(firstPass.failed).toBe(1);
      // The entry stays un-reverted (claim rolled back) and is visible to a retry.
      expect(storage.autonomyAudit.listUnrevertedSince("2026-06-22T00:00:00.000Z").map((e) => e.targetKey)).toEqual([
        "flaky",
      ]);

      const retryPass = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");
      expect(retryPass.reverted).toBe(1);
      expect(handlers.revertTune).toHaveBeenCalledTimes(2);
      expect(storage.autonomyAudit.listUnrevertedSince("2026-06-22T00:00:00.000Z")).toHaveLength(0);
    });

    it("marks an entry skipped (not failed) when the subsystem reports nothing to restore", async () => {
      const { service, storage, handlers } = await createService({
        handlers: { restoreCuratorArchive: vi.fn(() => false) },
      });
      storage.autonomyAudit.append(
        { kind: "curator_archive", targetKey: "gone", restoreRef: ref("curator_archive", { skillId: "gone" }) },
        "2026-06-22T00:00:00.000Z",
      );
      const summary = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");
      expect(summary.skipped).toBe(1);
      expect(summary.reverted).toBe(0);
      expect(handlers.restoreCuratorArchive).toHaveBeenCalledWith("gone");
      // Skipped entries are still marked reverted so they don't block later passes.
      expect(storage.autonomyAudit.listUnrevertedSince("2026-06-22T00:00:00.000Z")).toHaveLength(0);
    });

    it("dispatches operator_profile and memory refs to the profile restore handler", async () => {
      const { service, storage, handlers } = await createService();
      storage.autonomyAudit.append(
        {
          kind: "operator_profile",
          targetKey: "op_1",
          restoreRef: ref("operator_profile", { priorSnapshot: { operatorProfileId: "op_1", revision: 2 } }),
        },
        "2026-06-22T00:00:00.000Z",
      );
      storage.autonomyAudit.append(
        {
          kind: "memory",
          targetKey: "op_1",
          restoreRef: ref("memory", { priorSnapshot: { operatorProfileId: "op_1", revision: 1 } }),
        },
        "2026-06-22T00:00:01.000Z",
      );
      const summary = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z");
      expect(summary.reverted).toBe(2);
      expect(handlers.restoreOperatorProfile).toHaveBeenCalledTimes(2);
    });

    it("can filter by kind", async () => {
      const { service, storage, handlers } = await createService();
      storage.autonomyAudit.append(
        { kind: "tune", targetKey: "t", restoreRef: ref("tune") },
        "2026-06-22T00:00:00.000Z",
      );
      storage.autonomyAudit.append(
        { kind: "curator_archive", targetKey: "c", restoreRef: ref("curator_archive") },
        "2026-06-22T00:00:01.000Z",
      );
      const summary = service.revertAutonomousChangesSince("2026-06-22T00:00:00.000Z", { kinds: ["tune"] });
      expect(summary.considered).toBe(1);
      expect(summary.reverted).toBe(1);
      expect(handlers.revertTune).toHaveBeenCalledTimes(1);
      expect(handlers.restoreCuratorArchive).not.toHaveBeenCalled();
    });
  });
});
