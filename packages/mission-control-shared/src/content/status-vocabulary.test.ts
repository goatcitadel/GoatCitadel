import { describe, expect, it } from "vitest";
import {
  humanizeToken,
  isFinishedRunStatus,
  presentApprovalOutcome,
  presentApprovalStatus,
  presentChangePlanStatus,
  presentChannelStatus,
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

  it("names the run statuses that can no longer change", () => {
    for (const status of ["completed", "failed", "cancelled", "dead_lettered"] as const)
      expect(isFinishedRunStatus(status)).toBe(true);
    for (const status of ["queued", "running", "waiting", "paused"] as const)
      expect(isFinishedRunStatus(status)).toBe(false);
  });

  it("maps decision, change, and risk states", () => {
    expect(presentChangePlanStatus("awaiting_confirmation")).toEqual({ label: "Needs confirmation", tone: "waiting" });
    expect(presentChangePlanStatus("rollback_failed")).toEqual({ label: "Rollback failed", tone: "failed" });
    expect(presentApprovalStatus("edited")).toEqual({ label: "Approved with edits", tone: "done" });
    expect(presentApprovalOutcome("policy_blocked")).toEqual({ label: "Blocked by policy", tone: "failed" });
    expect(presentRiskLevel("safe")).toEqual({ label: "Safe", tone: "neutral" });
    expect(presentRiskLevel("caution")).toEqual({ label: "Caution", tone: "waiting" });
    expect(presentRiskLevel("danger")).toEqual({ label: "Danger", tone: "failed" });
    expect(presentRiskLevel("nuclear")).toEqual({ label: "Nuclear", tone: "failed" });
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

describe("humanizeToken acronyms", () => {
  it.each([
    ["mesh_mcp_server", "Mesh MCP server"],
    ["url", "URL"],
    ["oauth_token", "OAuth token"],
    ["api_key", "API key"],
    ["repo_search", "Repo search"],
  ])("humanizeToken(%s) is %s (U-GL-007)", (value, label) => {
    expect(humanizeToken(value)).toBe(label);
  });
});

describe("presentTaskStatus", () => {
  it("labels every task status and keeps unknown values readable", async () => {
    const { presentTaskStatus } = await import("./status-vocabulary");
    expect(presentTaskStatus("in_progress")).toEqual({ label: "In progress", tone: "running" });
    expect(presentTaskStatus("blocked")).toEqual({ label: "Blocked", tone: "failed" });
    expect(presentTaskStatus("inbox")).toEqual({ label: "Not started", tone: "neutral" });
    expect(presentTaskStatus("archived_soon")).toEqual({ label: "Archived soon", tone: "neutral" });
  });
});

describe("presentChannelStatus", () => {
  it("presents channel statuses with the agreed labels", () => {
    expect(presentChannelStatus("on")).toEqual({ label: "On", tone: "done" });
    expect(presentChannelStatus("off")).toEqual({ label: "Off", tone: "neutral" });
    expect(presentChannelStatus("needs_attention")).toEqual({ label: "Needs you", tone: "waiting" });
    expect(presentChannelStatus("removed")).toEqual({ label: "Removed", tone: "neutral" });
  });
});
