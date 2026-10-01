import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { inboxCountLabel, inboxKnownCount, inboxMatchesWorkspace } from "./inbox-presentation";

const projection: OperatorInboxResponse = {
  authority: "derived_projection",
  workspaceId: "default",
  generatedAt: "2026-09-28T00:00:00Z",
  items: [],
  coverage: [],
  counts: {
    needs_decision: { known: 2, complete: true },
    proposals: { known: 0, complete: true },
    needs_attention: { known: 0, complete: false },
    updates: { known: 0, complete: false },
  },
};

describe("Inbox counts", () => {
  it("rejects a foreign response or item before using its counts", () => {
    expect(inboxMatchesWorkspace(projection, "default")).toBe(true);
    expect(inboxMatchesWorkspace({ ...projection, workspaceId: "elsewhere" }, "default")).toBe(false);
    expect(inboxMatchesWorkspace({ ...projection, items: [{
      id: "foreign", kind: "approval", group: "needs_decision", title: "Foreign item", summary: "",
      createdAt: "2026-09-28T00:00:00Z", source: { workspaceId: "elsewhere" }, href: "/ops/approvals",
    }] }, "default")).toBe(false);
  });
  it("labels incomplete counts as lower bounds", () => {
    expect(inboxKnownCount(projection)).toEqual({ known: 2, complete: false });
    expect(inboxCountLabel(projection)).toBe("2+");
    expect(inboxCountLabel({ ...projection, counts: {
      ...projection.counts, needs_decision: { known: 0, complete: true },
    } })).toBe("?");
  });

  it("hides only a complete zero count", () => {
    expect(inboxCountLabel({ ...projection, counts: {
      needs_decision: { known: 0, complete: true },
      proposals: { known: 0, complete: true },
      needs_attention: { known: 0, complete: true },
      updates: { known: 0, complete: true },
    } })).toBeNull();
  });
});
