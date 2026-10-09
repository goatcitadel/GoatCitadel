import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  inboxCountIsExact,
  inboxCountLabel,
  inboxCountTitle,
  inboxKnownCount,
  inboxMatchesWorkspace,
  inboxNavigationLabel,
  inboxReadGaps,
} from "./inbox-presentation";

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
    expect(
      inboxMatchesWorkspace(
        {
          ...projection,
          items: [
            {
              id: "foreign",
              kind: "approval",
              group: "needs_decision",
              title: "Foreign item",
              summary: "",
              createdAt: "2026-09-28T00:00:00Z",
              source: { workspaceId: "elsewhere" },
              href: "/ops/approvals",
            },
          ],
        },
        "default",
      ),
    ).toBe(false);
  });
  it("labels incomplete counts as lower bounds", () => {
    expect(inboxKnownCount(projection)).toEqual({ known: 2, complete: false });
    expect(inboxCountLabel(projection)).toBe("2");
    expect(
      inboxCountLabel({
        ...projection,
        counts: {
          ...projection.counts,
          needs_decision: { known: 0, complete: true },
        },
      }),
    ).toBeNull();
  });

  it("reads a count exactly when a declared scope is the only reason it is incomplete", () => {
    const limited: OperatorInboxResponse = {
      ...projection,
      coverage: [
        { source: "runtime_health", state: "limited", detail: "Other checks remain in System." },
        { source: "memory_proposals", state: "not_enabled" },
      ],
    };
    expect(inboxCountIsExact(limited, false)).toBe(false);
    expect(inboxCountLabel(limited)).toBe("2");
    expect(inboxNavigationLabel(inboxCountLabel(limited))).toBe("Inbox, 2 decisions");
    const gap: OperatorInboxResponse = {
      ...limited,
      coverage: [...limited.coverage, { source: "dead_letters", state: "partial" }],
    };
    expect(inboxReadGaps(gap).map((source) => source.source)).toEqual(["dead_letters"]);
    expect(inboxCountLabel(gap)).toBe("2");
  });

  it("marks an unread source even when nothing is known", () => {
    const unread: OperatorInboxResponse = {
      ...projection,
      coverage: [{ source: "dead_letters", state: "unavailable" }],
      counts: { ...projection.counts, needs_decision: { known: 0, complete: false } },
    };
    expect(inboxCountLabel(unread)).toBe("?");
    expect(inboxNavigationLabel("?")).toBe("Inbox, some sources could not be read");
    expect(inboxNavigationLabel("1")).toBe("Inbox, 1 decision");
    expect(inboxNavigationLabel("1+")).toBe("Inbox, at least 1 decision");
    expect(inboxCountTitle("?")).toBe("Some decision coverage is incomplete");
  });

  it("hides a zero count", () => {
    expect(
      inboxCountLabel({
        ...projection,
        counts: {
          needs_decision: { known: 0, complete: true },
          proposals: { known: 0, complete: true },
          needs_attention: { known: 0, complete: true },
          updates: { known: 0, complete: true },
        },
      }),
    ).toBeNull();
  });
});
