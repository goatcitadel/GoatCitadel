import { describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import {
  approveDryRun,
  commitDryRun,
  computeDryRunHash,
  createDryRunPreview,
  createInMemoryDryRunCommitStore,
  decideDryRunEnforcement,
  type DryRunPlannedAction,
  wardRequiresDryRun,
} from "./dry-run-commit-service.js";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";

const PLANNED: DryRunPlannedAction = {
  route: "integration.action.invoke",
  target: "conn-1:trigger_webhook",
  payload: { flowId: "flow-1", body: { message: "send", to: "ops@example.com" } },
};

async function preview(store = createInMemoryDryRunCommitStore()) {
  const record = await createDryRunPreview(store, {
    runId: "extfx-1",
    boundary: "integration_operator_action",
    plannedAction: PLANNED,
    payloadHash: "payload-hash",
    workspaceId: "ws-1",
    createdAt: "2026-06-19T00:00:00.000Z",
  });
  return { store, record };
}

describe("dry-run-commit-service", () => {
  describe("computeDryRunHash", () => {
    it("is stable for a given planned action regardless of payload key order", () => {
      const a = computeDryRunHash(PLANNED);
      const reordered: DryRunPlannedAction = {
        route: "integration.action.invoke",
        target: "conn-1:trigger_webhook",
        payload: { body: { to: "ops@example.com", message: "send" }, flowId: "flow-1" },
      };
      expect(computeDryRunHash(reordered)).toBe(a);
      // It is a hex sha256 digest.
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("changes when route, target, or payload changes", () => {
      const base = computeDryRunHash(PLANNED);
      expect(computeDryRunHash({ ...PLANNED, route: "integration.action.other" })).not.toBe(base);
      expect(computeDryRunHash({ ...PLANNED, target: "conn-2:trigger_webhook" })).not.toBe(base);
      expect(computeDryRunHash({ ...PLANNED, payload: { flowId: "flow-1", body: { message: "DRAINED" } } })).not.toBe(
        base,
      );
    });
  });

  describe("createDryRunPreview", () => {
    it("yields a stable dryRunHash and an awaiting-commit record without crossing any boundary", async () => {
      const { record } = await preview();
      expect(record.state).toBe("awaiting_commit");
      expect(record.dryRunHash).toBe(computeDryRunHash(PLANNED));
      expect(record.approvedAt).toBeUndefined();
      expect(record.committedAt).toBeUndefined();
      expect(record.dryRunId).toMatch(/^dryrun-/);
    });
  });

  describe("commitDryRun", () => {
    it("commits and crosses the boundary EXACTLY ONCE when the committed action matches the approved dry-run", async () => {
      const { store, record } = await preview();
      await approveDryRun(store, record.dryRunId, {
        approvedBy: "operator",
        approvedAt: "2026-06-19T00:01:00.000Z",
      });

      const boundary = vi.fn(async () => ({ output: { id: "msg-123" } }));
      const result = await commitDryRun(store, {
        dryRunId: record.dryRunId,
        committedAction: PLANNED,
        committedAt: "2026-06-19T00:02:00.000Z",
        async execute(ctx) {
          ctx.markExternalCallStarted();
          return boundary();
        },
      });

      expect(result.status).toBe("committed");
      expect(boundary).toHaveBeenCalledTimes(1);
      if (result.status === "committed") {
        expect(result.record.state).toBe("committed");
        expect(result.record.committedAt).toBe("2026-06-19T00:02:00.000Z");
        expect(result.record.externalReferenceId).toBe("id:msg-123");
      }
    });

    it("REJECTS the commit BEFORE the boundary when the committed action differs from the dry-run (the moat)", async () => {
      const { store, record } = await preview();
      await approveDryRun(store, record.dryRunId, {
        approvedBy: "operator",
        approvedAt: "2026-06-19T00:01:00.000Z",
      });

      const boundary = vi.fn(async () => ({ output: { id: "should-never-happen" } }));
      // The agent previewed sending to ops@example.com but tries to commit a drained-funds payload.
      const tampered: DryRunPlannedAction = {
        route: "integration.action.invoke",
        target: "conn-1:trigger_webhook",
        payload: { flowId: "flow-1", body: { message: "send", to: "attacker@evil.example" } },
      };

      const result = await commitDryRun(store, {
        dryRunId: record.dryRunId,
        committedAction: tampered,
        committedAt: "2026-06-19T00:02:00.000Z",
        async execute(ctx) {
          ctx.markExternalCallStarted();
          return boundary();
        },
      });

      // The boundary was NEVER reached.
      expect(boundary).not.toHaveBeenCalled();
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.diagnostic.code).toBe("hash_mismatch");
        expect(result.diagnostic.approvedDryRunHash).toBe(record.dryRunHash);
        expect(result.diagnostic.attemptedCommitHash).toBe(computeDryRunHash(tampered));
        expect(result.diagnostic.attemptedCommitHash).not.toBe(record.dryRunHash);
        expect(result.record.state).toBe("rejected_hash_mismatch");
      }
      // The rejection is durable on the record.
      expect(store.get(record.dryRunId)?.state).toBe("rejected_hash_mismatch");
      expect(store.get(record.dryRunId)?.diagnostic?.code).toBe("hash_mismatch");
    });

    it("refuses to commit an unapproved (but matching) dry-run before the boundary", async () => {
      const { store, record } = await preview();
      const boundary = vi.fn(async () => ({ output: { id: "x" } }));

      const result = await commitDryRun(store, {
        dryRunId: record.dryRunId,
        committedAction: PLANNED,
        committedAt: "2026-06-19T00:02:00.000Z",
        async execute(ctx) {
          ctx.markExternalCallStarted();
          return boundary();
        },
      });

      expect(boundary).not.toHaveBeenCalled();
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.diagnostic.code).toBe("not_approved");
      }
    });

    it("cannot be committed twice (second commit is refused, boundary not re-crossed)", async () => {
      const { store, record } = await preview();
      await approveDryRun(store, record.dryRunId, { approvedAt: "2026-06-19T00:01:00.000Z" });
      const boundary = vi.fn(async () => ({ output: { id: "once" } }));

      const first = await commitDryRun(store, {
        dryRunId: record.dryRunId,
        committedAction: PLANNED,
        committedAt: "2026-06-19T00:02:00.000Z",
        execute: async (ctx) => {
          ctx.markExternalCallStarted();
          return boundary();
        },
      });
      const second = await commitDryRun(store, {
        dryRunId: record.dryRunId,
        committedAction: PLANNED,
        committedAt: "2026-06-19T00:03:00.000Z",
        execute: async (ctx) => {
          ctx.markExternalCallStarted();
          return boundary();
        },
      });

      expect(first.status).toBe("committed");
      expect(second.status).toBe("rejected");
      if (second.status === "rejected") {
        expect(second.diagnostic.code).toBe("not_awaiting_commit");
      }
      expect(boundary).toHaveBeenCalledTimes(1);
    });

    it("records a durable diagnostic and surfaces reconciliation state when the matched commit fails downstream", async () => {
      const { store, record } = await preview();
      await approveDryRun(store, record.dryRunId, { approvedAt: "2026-06-19T00:01:00.000Z" });

      const result = await commitDryRun(store, {
        dryRunId: record.dryRunId,
        committedAction: PLANNED,
        committedAt: "2026-06-19T00:02:00.000Z",
        async execute(ctx) {
          ctx.markExternalCallStarted();
          throw new Error("provider 500");
        },
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.diagnostic.code).toBe("commit_execution_failed");
        expect(result.diagnostic.message).toContain("manual reconciliation required");
        expect(result.record.state).toBe("rejected_commit_failed");
      }
    });

    it("throws on an unknown dry-run id", async () => {
      const store = createInMemoryDryRunCommitStore();
      await expect(
        commitDryRun(store, {
          dryRunId: "dryrun-nope",
          committedAction: PLANNED,
          committedAt: "2026-06-19T00:02:00.000Z",
          execute: async () => ({}),
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("Ward enforcement decision", () => {
    it("forces the dry-run flow only for require_dry_run", () => {
      expect(decideDryRunEnforcement("require_dry_run")).toBe("force_dry_run");
      expect(wardRequiresDryRun("require_dry_run")).toBe(true);
      for (const effect of ["allow", "deny", "require_approval", "redact", "route_local", undefined] as const) {
        expect(decideDryRunEnforcement(effect)).toBe("pass_through");
        expect(wardRequiresDryRun(effect)).toBe(false);
      }
    });
  });

  describe("runner enforcement of require_dry_run", () => {
    it("blocks a direct execute into the dry-run flow (boundary never reached)", async () => {
      const execute = vi.fn(async (claim: { markExternalCallStarted(): void }) => {
        claim.markExternalCallStarted();
        return { output: { id: "leaked" } };
      });

      const result = await runIdempotentExternalSideEffect({
        label: "Trigger webhook",
        boundary: "integration_operator_action",
        catalogId: "automation.activepieces",
        connectionId: "conn-1",
        actionId: "trigger_webhook",
        checkedAt: "2026-06-19T00:00:00.000Z",
        payload: { flowId: "flow-1" },
        wardEffect: "require_dry_run",
        execute,
      });

      expect(execute).not.toHaveBeenCalled();
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") {
        expect(result.blockedReason).toBe("external_side_effect_dry_run_required");
        expect(result.output.dryRunRequired).toBe(true);
      }
    });

    it("still executes normally when no require_dry_run Ward is in effect (backward-compatible)", async () => {
      const execute = vi.fn(async (claim: { markExternalCallStarted(): void }) => {
        claim.markExternalCallStarted();
        return { output: { id: "ok" } };
      });
      const mutationStore = {
        claim: vi.fn(() => ({
          outcome: "claimed" as const,
          claimKind: "new" as const,
          record: {
            method: "POST",
            routePath: "external",
            idempotencyKey: "operator-key",
            actorScope: "conn-1",
            payloadHash: "hash",
            status: "pending" as const,
            createdAt: "2026-06-19T00:00:00.000Z",
            updatedAt: "2026-06-19T00:00:00.000Z",
          },
        })),
        markCompleted: vi.fn(),
        markFailed: vi.fn(),
      };

      const result = await runIdempotentExternalSideEffect({
        label: "Trigger webhook",
        mutationStore,
        boundary: "integration_operator_action",
        catalogId: "automation.activepieces",
        connectionId: "conn-1",
        actionId: "trigger_webhook",
        checkedAt: "2026-06-19T00:00:00.000Z",
        payload: { flowId: "flow-1" },
        // no wardEffect → unchanged behavior: a successful claim executes as before.
        execute,
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("executed");
    });
  });

  describe("durable storage ledger", () => {
    it("runs preview → refuse-unapproved → approve → commit against the sqlite-backed store", async () => {
      const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
      try {
        const asyncDryRunCommits = createSqliteAsyncStorage(storage).dryRunCommits;
        const record = await createDryRunPreview(asyncDryRunCommits, {
          runId: "extfx-durable-1",
          boundary: "integration_operator_action",
          plannedAction: PLANNED,
          payloadHash: "payload-hash",
          workspaceId: "ws-1",
          createdAt: "2026-07-07T00:00:00.000Z",
        });
        expect(storage.dryRunCommits.get(record.dryRunId)?.state).toBe("awaiting_commit");

        const premature = await commitDryRun(asyncDryRunCommits, {
          dryRunId: record.dryRunId,
          committedAction: PLANNED,
          committedAt: "2026-07-07T00:01:00.000Z",
          execute: async () => "never",
        });
        expect(premature.status).toBe("rejected");
        expect(storage.dryRunCommits.get(record.dryRunId)?.diagnostic?.code).toBe("not_approved");

        await approveDryRun(asyncDryRunCommits, record.dryRunId, {
          approvedBy: "operator",
          approvedAt: "2026-07-07T00:02:00.000Z",
        });

        const committed = await commitDryRun(asyncDryRunCommits, {
          dryRunId: record.dryRunId,
          committedAction: PLANNED,
          committedAt: "2026-07-07T00:03:00.000Z",
          execute: async (context) => {
            context.markExternalCallStarted();
            return { output: { id: "ext-1" } };
          },
        });
        expect(committed.status).toBe("committed");
        expect(storage.dryRunCommits.get(record.dryRunId)).toMatchObject({
          state: "committed",
          approvedBy: "operator",
          committedAt: "2026-07-07T00:03:00.000Z",
          externalReferenceId: "id:ext-1",
        });
      } finally {
        storage.close();
      }
    });
  });
});
