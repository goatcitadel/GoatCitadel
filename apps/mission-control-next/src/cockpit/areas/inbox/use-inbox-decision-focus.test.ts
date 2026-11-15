// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { decisionOutcome, useInboxDecisionFocus } from "./use-inbox-decision-focus";

describe("decisionOutcome", () => {
  it("names the denied item", () => {
    const outcome = decisionOutcome(
      "Review file write",
      "Decision recorded: Denied. Follow-on execution needs separate verification.",
    );
    expect(outcome.verdict).toBe("Denied Review file write.");
    expect(outcome.announcement).toBe("Denied Review file write. Follow-on execution needs separate verification.");
  });

  it("names the approved item the same way", () => {
    expect(
      decisionOutcome("Run command", "Decision recorded: Approved. Follow-on settlement is pending.").verdict,
    ).toBe("Approved Run command.");
    expect(decisionOutcome("Run command", "Decision recorded: Approved with edits. x").verdict).toBe(
      "Approved with edits Run command.",
    );
  });

  it("passes any other message through unchanged", () => {
    const message = "The approval changed. Review the refreshed record before deciding.";
    expect(decisionOutcome("Run command", message)).toEqual({ verdict: null, announcement: message });
  });
});

describe("useInboxDecisionFocus selection", () => {
  const item = (id: string): OperatorInboxItem => ({
    id,
    kind: "approval",
    group: "needs_decision",
    title: id,
    summary: "",
    createdAt: "2026-09-28T00:00:00Z",
    source: { workspaceId: "default", approvalId: id },
    href: "/inbox",
  });

  it("marks no row Selected after a settled decision (U-IN-008)", async () => {
    const select = vi.fn();
    let onDecision!: (item: OperatorInboxItem, message: string, settled: boolean) => void;
    function Probe() {
      onDecision = useInboxDecisionFocus({
        orderedItems: [item("a"), item("b")],
        groupOf: () => "needs_decision",
        listHandles: { current: new Map() },
        select,
        announce: vi.fn(),
      }).onDecision;
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => onDecision(item("a"), "Decision recorded: Denied.", false));
    expect(select).not.toHaveBeenCalled();
    await act(async () => onDecision(item("a"), "Decision recorded: Denied.", true));
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(null);
    await act(async () => root.unmount());
  });
});
