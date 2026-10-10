import assert from "node:assert/strict";
import { remoteWorkerAssignmentCanonicalSha256 as digest } from "@goatcitadel/contracts";
import { it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { seedProtectedFenceHarness } from "./remote-worker-protected-fence-fixture.js";
import { verifyWorkerChatApprovalResume } from "./remote-worker-chat-resume-fixture.js";
import { RemoteWorkerChatResumeLedger } from "./remote-worker-chat-resume-ledger.js";

it("retains only the canonical approved intent across heartbeat and owned lease rotation", async () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    const seed = "approved-continuation";
    const h = seedProtectedFenceHarness(db, seed, true);
    await verifyWorkerChatApprovalResume(
      db,
      seed,
      {
        workerId: h.finalized.generation.workerId,
        workerGeneration: h.finalized.generation.workerGeneration,
        nodeId: h.finalized.generation.nodeId,
        nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
      },
      h.fence,
      "approve",
      (input) => {
        const continuation = input.continuingApprovedTool!;
        const exact = {
          registryWorkspaceId: input.registryWorkspaceId,
          assignmentId: input.assignmentId,
          assignmentGeneration: input.assignmentGeneration,
          leaseTokenSha256: digest(`new-token:${seed}`),
        };
        const execution = h.assignments.resolveActiveChatExecution(exact, h.fence);
        const runId = execution.authority.assignment.manifest.durableRunId;
        const run = h.durableRuns.getRun(runId);
        h.durableRuns.renewLeaseWithDatabaseClock({ runId, workerId: run.leaseOwnerId!, leaseDurationMs: 300_000 });
        assert.throws(() => h.assignments.resolveActiveChatExecution(exact, h.fence));
        assert.equal(
          h.assignments.resolveActiveChatExecution(input, h.fence).workload.durableRunPayloadSha256,
          continuation.durableRunPayloadSha256,
        );
        const rotated = h.assignments.renewLease(
          {
            registryWorkspaceId: input.registryWorkspaceId,
            assignmentId: input.assignmentId,
            expectedAssignmentGeneration: input.assignmentGeneration,
            expectedLeaseRevision: continuation.leaseRevision,
            expectedLeaseTokenSha256: exact.leaseTokenSha256,
            leaseTokenSha256: digest("rotated-approved-lease"),
            workerSentThrough: 0,
            idempotencyKey: "approved-rotation",
          },
          h.fence,
        );
        assert.equal(
          h.assignments.resolveActiveChatExecution(input, h.fence).authority.lease.leaseRevision,
          rotated.lease.leaseRevision,
        );
        assert.throws(() => h.assignments.resolveActiveChatExecution(exact, h.fence));

        for (const patch of [
          { intentId: "foreign-intent" },
          { intentSha256: digest("foreign-intent") },
          { resumeMaterialSha256: digest("foreign-resume") },
          { durableRunPayloadSha256: digest("foreign-payload") },
          { leaseRevision: 1 },
          { parentDispatchAuthority: { ...continuation.parentDispatchAuthority, dispatchOwnerId: "foreign-owner" } },
        ]) {
          assert.throws(() =>
            h.assignments.resolveActiveChatExecution(
              { ...input, continuingApprovedTool: { ...continuation, ...patch } },
              h.fence,
            ),
          );
        }
        assert.throws(() =>
          h.assignments.resolveActiveChatExecution({ ...input, leaseTokenSha256: exact.leaseTokenSha256 }, h.fence),
        );
        assert.throws(() =>
          h.assignments.resolveActiveChatExecution(input, {
            ...h.fence,
            credentialAuthority: { ...h.fence.credentialAuthority, authorizationCredentialSha256: digest("revoked") },
          }),
        );

        const resume = new RemoteWorkerChatResumeLedger(db).readLatest(
          input.registryWorkspaceId,
          input.assignmentId,
          input.assignmentGeneration,
        )!;
        for (const drift of [
          "owner",
          "attempt",
          "payload",
          "expiry",
          "terminal",
          "approval",
          "pending",
          "cancel",
        ] as const) {
          const rollback = new Error(`rollback-${drift}`);
          assert.throws(
            () =>
              db.transaction("immediate", () => {
                const current = h.durableRuns.getRun(runId);
                if (drift === "owner")
                  h.durableRuns.updateRun({
                    runId,
                    status: "running",
                    expectedVersion: current.version,
                    leaseOwnerId: "foreign",
                  });
                if (drift === "attempt")
                  h.durableRuns.updateRun({
                    runId,
                    status: "running",
                    expectedVersion: current.version,
                    attemptCount: current.attemptCount + 1,
                  });
                if (drift === "payload")
                  h.durableRuns.updateRun({
                    runId,
                    status: "running",
                    expectedVersion: current.version,
                    payload: { ...current.payload, changed: true },
                  });
                if (drift === "expiry")
                  h.durableRuns.updateRun({
                    runId,
                    status: "running",
                    expectedVersion: current.version,
                    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
                  });
                if (drift === "terminal")
                  h.durableRuns.updateRun({ runId, status: "completed", expectedVersion: current.version });
                if (drift === "approval")
                  db.prepare("UPDATE approvals SET status = 'rejected' WHERE approval_id = ?").run(
                    resume.material.approvalId,
                  );
                if (drift === "pending")
                  db.prepare("UPDATE pending_approval_actions SET request_json = '{}' WHERE approval_id = ?").run(
                    resume.material.approvalId,
                  );
                if (drift === "cancel")
                  h.assignments.requestCancellation({
                    registryWorkspaceId: input.registryWorkspaceId,
                    assignmentId: input.assignmentId,
                    expectedAssignmentGeneration: input.assignmentGeneration,
                    expectedLeaseRevision: rotated.lease.leaseRevision,
                    reasonCode: "operator.cancelled",
                    reasonSha256: digest("cancel"),
                    actorId: "operator",
                    idempotencyKey: "approved-cancel",
                  });
                assert.throws(() => h.assignments.resolveActiveChatExecution(input, h.fence), `must reject ${drift}`);
                throw rollback;
              }),
            (error) => error === rollback,
          );
          assert.ok(h.assignments.resolveActiveChatExecution(input, h.fence));
        }
      },
    );
  } finally {
    db.close();
  }
});
