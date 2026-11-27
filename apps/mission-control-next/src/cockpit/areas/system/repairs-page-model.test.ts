import { describe, expect, it } from "vitest";
import type { RuntimeRepairFinding, RuntimeRepairSweepSnapshot } from "@goatcitadel/contracts";
import { buildRepairsPage, presentRepairCheck, presentRepairFinding } from "./repairs-page-model";

function finding(overrides: Partial<RuntimeRepairFinding> = {}): RuntimeRepairFinding {
  return {
    findingId: "finding-1",
    detectorId: "approval.resolved-wait-not-woken",
    detectorVersion: 1,
    fingerprint: "fp-1",
    subject: { runId: "run/1", approvalId: "approval-1" },
    summary: "An approval was answered, but the run waiting on it never continued.",
    proposedTier: "automatic",
    facts: { approvalStatus: "approved", minutesSinceResolved: 12 },
    state: "observed",
    firstSeenAt: "2026-11-27T11:50:00.000Z",
    lastSeenAt: "2026-11-27T12:00:00.000Z",
    seenCount: 3,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RuntimeRepairSweepSnapshot> = {}): RuntimeRepairSweepSnapshot {
  return {
    mode: "detect_only",
    ready: true,
    lastTickAt: "2026-11-27T12:00:00.000Z",
    detectors: [
      { detectorId: "approval.resolved-wait-not-woken", lastRunAt: "2026-11-27T12:00:00.000Z", truncated: false },
      { detectorId: "durable.dead-letter", lastRunAt: "2026-11-27T12:00:00.000Z", truncated: true },
    ],
    open: [],
    recentlyCleared: [],
    ...overrides,
  };
}

describe("repairs page model", () => {
  it("says when the first check has not run", () => {
    expect(buildRepairsPage(snapshot({ ready: false, lastTickAt: undefined })).state).toBe("first_check_pending");
  });

  it("says nothing looks stuck only after a check ran and every check could read its source", () => {
    expect(buildRepairsPage(snapshot()).state).toBe("all_clear");
  });

  it("never calls the page clear when a check could not run", () => {
    const page = buildRepairsPage(
      snapshot({
        detectors: [
          {
            detectorId: "approval.expiry-lagging",
            lastRunAt: "2026-11-27T12:00:00.000Z",
            truncated: false,
            lastError: "x",
          },
        ],
      }),
    );
    expect(page.state).toBe("findings");
    expect(page.intro).toBe(
      "Nothing looked stuck, but 1 check couldn't run. Its problems would stay listed until it can check again.",
    );
  });

  it("leads with a sentence and counts that say what they mean", () => {
    const page = buildRepairsPage(
      snapshot({ open: [finding(), finding({ findingId: "f-2", fingerprint: "fp-2" })], recentlyCleared: [finding()] }),
    );
    expect(page.state).toBe("findings");
    expect(page.intro).toBe("2 things look stuck as of the last check. GoatCitadel checks every 5 minutes.");
    expect(page.metrics.map((metric) => [metric.term, metric.value])).toEqual([
      ["Open", "2"],
      ["Cleared since this Gateway started", "1"],
    ]);
  });

  it("links a run finding to the run, with the run id escaped", () => {
    expect(presentRepairFinding(finding())).toMatchObject({
      link: { href: "/work/runs/run%2F1", label: "Open run" },
      tier: { label: "Can be fixed automatically later" },
      detail: "Answered 12 min ago · seen 3 times",
    });
  });

  it("links an approval finding to the approval", () => {
    const presented = presentRepairFinding(
      finding({
        detectorId: "approval.no-inbox",
        subject: { approvalId: "a 1" },
        proposedTier: "report",
        facts: { approvalKind: "tool.invoke", minutesPending: 130 },
        seenCount: 1,
      }),
    );
    expect(presented.link).toEqual({ href: "/inbox?approvalId=a%201", label: "Review approval" });
    expect(presented.tier.label).toBe("Needs you");
    expect(presented.detail).toBe("Waiting 2 h 10 min");
  });

  it("keeps raw values out of the visible text and puts them in technical details", () => {
    const presented = presentRepairFinding(
      finding({
        detectorId: "durable.dead-letter",
        subject: { runId: "run-9", deadLetterId: "dead-1" },
        proposedTier: "proposed",
        facts: { transient: false, reason: "Workflow payload failed validation." },
      }),
    );
    expect(presented.tier.label).toBe("Will ask you first");
    expect(presented.detail).not.toContain("validation");
    expect(presented.technical).toEqual([
      ["Check", "durable.dead-letter"],
      ["Run", "run-9"],
      ["Dead letter", "dead-1"],
      ["Recorded reason", "Workflow payload failed validation."],
    ]);
  });

  it("offers no link when the finding names nothing it can open", () => {
    expect(presentRepairFinding(finding({ subject: {} })).link).toBeNull();
  });

  it("describes each check in plain words, including partial and failed reads", () => {
    expect(
      presentRepairCheck({ detectorId: "durable.dead-letter", lastRunAt: "2026-11-27T12:00:00.000Z", truncated: true }),
    ).toEqual({ label: "Runs that stopped for good", note: "Only the newest ones were checked", failed: false });
    expect(
      presentRepairCheck({
        detectorId: "approval.expiry-lagging",
        lastRunAt: "2026-11-27T12:00:00.000Z",
        truncated: false,
        lastError: "connection refused",
      }),
    ).toEqual({ label: "Approvals past their expiry", note: "Couldn't check this time", failed: true });
    expect(presentRepairCheck({ detectorId: "approval.no-inbox", truncated: false })).toEqual({
      label: "Approvals no Inbox shows",
      note: "Not checked yet",
      failed: false,
    });
  });
});
