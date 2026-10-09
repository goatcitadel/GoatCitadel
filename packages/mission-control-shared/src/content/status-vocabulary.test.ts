import { describe, expect, it } from "vitest";
import {
  humanizeToken,
  presentApprovalOutcome,
  presentApprovalStatus,
  presentChangePlanStatus,
  presentChatTurnStatus,
  presentEventClass,
  presentEventType,
  presentRiskLevel,
  presentRunStatus,
  presentToolEffectOutcome,
} from "./status-vocabulary";

describe("status vocabulary", () => {
  it("distinguishes a run waiting on the operator from another wait", () => {
    expect(presentRunStatus("waiting")).toEqual({ label: "Waiting", tone: "neutral" });
    expect(presentRunStatus("waiting", { waitingOnOperator: true })).toEqual({
      label: "Waiting on you",
      tone: "waiting",
    });
    expect(presentRunStatus("dead_lettered")).toEqual({ label: "Failed · needs recovery", tone: "failed" });
    expect(presentChatTurnStatus("waiting_for_approval")).toEqual({ label: "Waiting on you", tone: "waiting" });
  });

  it("maps decision, change, and risk states", () => {
    expect(presentChangePlanStatus("awaiting_confirmation")).toEqual({ label: "Needs confirmation", tone: "waiting" });
    expect(presentChangePlanStatus("rollback_failed")).toEqual({ label: "Rollback failed", tone: "failed" });
    expect(presentApprovalStatus("edited")).toEqual({ label: "Approved with edits", tone: "done" });
    expect(presentApprovalOutcome("policy_blocked")).toEqual({ label: "Blocked by policy", tone: "failed" });
    expect(presentRiskLevel("safe")).toEqual({ label: "Low", tone: "neutral" });
    expect(presentRiskLevel("caution")).toEqual({ label: "Medium", tone: "waiting" });
    expect(presentRiskLevel("danger")).toEqual({ label: "High", tone: "failed" });
    expect(presentRiskLevel("nuclear")).toEqual({ label: "Critical", tone: "failed" });
    // A level a newer Gateway sends must still render instead of crashing the badge.
    expect(presentRiskLevel("critical_infra" as never)).toEqual({ label: "Critical infra", tone: "failed" });
  });

  it("turns internal event and effect tokens into readable copy", () => {
    expect(presentEventClass("domain_fact")).toBe("Record");
    expect(presentEventClass()).toBe("Event");
    expect(presentEventType("change_plan.awaiting_approval")).toBe("Change plan awaiting approval");
    expect(humanizeToken("remote_worker.assignment-changed")).toBe("Remote worker assignment changed");
    expect(presentToolEffectOutcome("uncertain")).toBe("Outcome uncertain. Check before retrying.");
  });
});
