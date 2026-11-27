import { describe, expect, it } from "vitest";
import type { ApprovalRequest, DurableDeadLetterRecord, DurableRunRecord } from "@goatcitadel/contracts";
import {
  RUNTIME_REPAIR_THRESHOLDS,
  classifyTransientFailure,
  detectRuntimeRepairFindings,
  runtimeRepairFingerprint,
  type RuntimeRepairObservation,
} from "./runtime-repair-detectors.js";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function run(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
    runId: "run-1",
    workflowKey: "approval.wait",
    status: "waiting",
    attemptCount: 1,
    maxAttempts: 3,
    version: 1,
    payload: { version: "approval.wait.v1", approvalId: "approval-1" },
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(30),
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "approval-1",
    kind: "tool.invoke",
    riskLevel: "medium",
    status: "pending",
    payload: {},
    preview: {},
    linkage: { workspaceId: "workspace-1" },
    createdAt: minutesAgo(20),
    ...overrides,
  } as ApprovalRequest;
}

function deadLetter(overrides: Partial<DurableDeadLetterRecord> = {}): DurableDeadLetterRecord {
  return {
    deadLetterId: "dead-1",
    runId: "run-9",
    reason: "retry_exhausted: provider returned HTTP 503 Service Unavailable",
    payload: {},
    createdAt: minutesAgo(10),
    ...overrides,
  };
}

function observation(overrides: Partial<RuntimeRepairObservation> = {}): RuntimeRepairObservation {
  return {
    nowMs: NOW,
    approvalWaits: [],
    pendingApprovals: [],
    expiredPendingApprovals: [],
    deadLetters: [],
    recentRuns: [],
    ...overrides,
  };
}

function ids(observed: RuntimeRepairObservation): string[] {
  return detectRuntimeRepairFindings(observed).map((finding) => finding.detectorId);
}

describe("runtime repair detectors", () => {
  it("finds nothing in a healthy runtime", () => {
    expect(
      detectRuntimeRepairFindings(
        observation({
          approvalWaits: [{ run: run(), approvalId: "approval-1", approval: approval() }],
          pendingApprovals: [approval()],
          deadLetters: [deadLetter({ resolvedAt: minutesAgo(1) })],
          recentRuns: [run({ status: "completed" })],
        }),
      ),
    ).toEqual([]);
  });

  describe("approval.resolved-wait-not-woken", () => {
    it("flags a waiting run whose approval was resolved past the grace period", () => {
      const findings = detectRuntimeRepairFindings(
        observation({
          approvalWaits: [
            {
              run: run(),
              approvalId: "approval-1",
              approval: approval({ status: "approved", resolvedAt: minutesAgo(5) }),
            },
          ],
        }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        detectorId: "approval.resolved-wait-not-woken",
        subject: { runId: "run-1", approvalId: "approval-1", workspaceId: "workspace-1" },
        proposedTier: "automatic",
        facts: { approvalStatus: "approved", minutesSinceResolved: 5 },
      });
    });

    it("waits out the grace period so a normal wake is not flagged", () => {
      const resolvedAt = new Date(NOW - RUNTIME_REPAIR_THRESHOLDS.resolvedWaitGraceMs + 1_000).toISOString();
      expect(
        ids(
          observation({
            approvalWaits: [
              { run: run(), approvalId: "approval-1", approval: approval({ status: "rejected", resolvedAt }) },
            ],
          }),
        ),
      ).toEqual([]);
    });

    it("ignores runs that are not waiting", () => {
      expect(
        ids(
          observation({
            approvalWaits: [
              {
                run: run({ status: "running" }),
                approvalId: "approval-1",
                approval: approval({ status: "approved", resolvedAt: minutesAgo(30) }),
              },
            ],
          }),
        ),
      ).toEqual([]);
    });
  });

  describe("approval.wait-orphaned", () => {
    it("flags a waiting run whose approval no longer exists", () => {
      const findings = detectRuntimeRepairFindings(
        observation({ approvalWaits: [{ run: run(), approvalId: "approval-gone", approval: null }] }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        detectorId: "approval.wait-orphaned",
        subject: { runId: "run-1", approvalId: "approval-gone" },
        proposedTier: "automatic",
      });
    });

    it("flags a waiting run with no approval id at all", () => {
      expect(
        ids(observation({ approvalWaits: [{ run: run({ payload: {} }), approvalId: undefined, approval: null }] })),
      ).toEqual(["approval.wait-orphaned"]);
    });

    it("does not flag a run created moments ago", () => {
      expect(
        ids(
          observation({
            approvalWaits: [{ run: run({ createdAt: minutesAgo(0.5) }), approvalId: "approval-gone", approval: null }],
          }),
        ),
      ).toEqual([]);
    });
  });

  describe("approval.no-inbox", () => {
    it("flags a pending approval linked to no workspace and no chat", () => {
      const findings = detectRuntimeRepairFindings(
        observation({
          pendingApprovals: [approval({ linkage: { durableRunId: "run-1", toolName: "shell.exec" } })],
        }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        detectorId: "approval.no-inbox",
        subject: { approvalId: "approval-1", runId: "run-1" },
        proposedTier: "report",
        facts: { approvalKind: "tool.invoke" },
      });
    });

    it("leaves install-wide approvals alone, because every Inbox lists them", () => {
      expect(ids(observation({ pendingApprovals: [approval({ linkage: undefined })] }))).toEqual([]);
    });

    it("leaves chat-linked approvals alone, because their chat shows them", () => {
      expect(ids(observation({ pendingApprovals: [approval({ linkage: { sessionId: "session-1" } })] }))).toEqual([]);
    });

    it("treats a blank workspace id as no workspace", () => {
      expect(ids(observation({ pendingApprovals: [approval({ linkage: { workspaceId: "  " } })] }))).toEqual([
        "approval.no-inbox",
      ]);
    });
  });

  describe("approval.expiry-lagging", () => {
    it("flags a pending approval well past its expiry", () => {
      const findings = detectRuntimeRepairFindings(
        observation({ expiredPendingApprovals: [approval({ expiresAt: minutesAgo(10) })] }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        detectorId: "approval.expiry-lagging",
        proposedTier: "report",
        facts: { minutesPastExpiry: 10 },
      });
    });

    it("gives the one-second expiry sweep time to run", () => {
      expect(
        ids(observation({ expiredPendingApprovals: [approval({ expiresAt: new Date(NOW - 5_000).toISOString() })] })),
      ).toEqual([]);
    });
  });

  describe("durable.dead-letter", () => {
    it("marks a dead letter with a temporary cause as a candidate for an automatic retry", () => {
      const findings = detectRuntimeRepairFindings(observation({ deadLetters: [deadLetter()] }));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        detectorId: "durable.dead-letter",
        subject: { deadLetterId: "dead-1", runId: "run-9" },
        proposedTier: "automatic",
        facts: { transient: true },
      });
    });

    it("sends any other dead letter to a proposal", () => {
      const findings = detectRuntimeRepairFindings(
        observation({ deadLetters: [deadLetter({ reason: "Workflow payload failed validation." })] }),
      );
      expect(findings[0]).toMatchObject({ proposedTier: "proposed", facts: { transient: false } });
    });

    it("ignores resolved dead letters", () => {
      expect(ids(observation({ deadLetters: [deadLetter({ resolvedAt: minutesAgo(1) })] }))).toEqual([]);
    });

    it("redacts and bounds the recorded reason", () => {
      const secret = "sk-ant-api03-" + "a".repeat(40);
      const [finding] = detectRuntimeRepairFindings(
        observation({ deadLetters: [deadLetter({ reason: `Request failed with key ${secret} ${"x".repeat(500)}` })] }),
      );
      const reason = String(finding?.facts.reason);
      expect(reason).not.toContain(secret);
      expect(reason.length).toBeLessThanOrEqual(RUNTIME_REPAIR_THRESHOLDS.reasonCharacters);
    });
  });

  describe("durable.reclaim-exhausted", () => {
    it("flags a run stopped after repeated worker restarts", () => {
      const findings = detectRuntimeRepairFindings(
        observation({
          recentRuns: [
            run({
              runId: "run-crash",
              workflowKey: "chat.turn.execute",
              status: "failed",
              lastError:
                "The run was restarted 8 times after its worker stopped without finishing, so it was stopped instead of being restarted again. Review the run before retrying it.",
            }),
          ],
        }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        detectorId: "durable.reclaim-exhausted",
        subject: { runId: "run-crash" },
        proposedTier: "report",
        facts: { workflowKey: "chat.turn.execute", restarts: 8 },
      });
    });

    it("ignores other failures", () => {
      expect(ids(observation({ recentRuns: [run({ status: "failed", lastError: "Provider error." })] }))).toEqual([]);
    });
  });

  it("gives the same problem the same fingerprint on every tick", () => {
    const observed = observation({ approvalWaits: [{ run: run(), approvalId: "approval-gone", approval: null }] });
    const first = detectRuntimeRepairFindings(observed)[0];
    const second = detectRuntimeRepairFindings({ ...observed, nowMs: NOW + 60_000 })[0];
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(first?.fingerprint).toBe(
      runtimeRepairFingerprint("approval.wait-orphaned", { runId: "run-1", approvalId: "approval-gone" }),
    );
  });

  it.each([
    ["HTTP 429 Too Many Requests", true],
    ["rate limit exceeded", true],
    ["request timed out after 30000ms", true],
    ["ETIMEDOUT", true],
    ["read ECONNRESET", true],
    ["502 Bad Gateway", true],
    ["provider overloaded", true],
    ["Workflow payload failed validation.", false],
    ["HTTP 401 Unauthorized", false],
    ["build 5031 failed", false],
  ])("classifies %j as transient=%s", (reason, transient) => {
    expect(classifyTransientFailure(reason)).toBe(transient);
  });
});
