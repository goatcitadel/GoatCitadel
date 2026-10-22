import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { WorkWaitingDecisions } from "./WorkWaitingDecisions";
const state = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: false,
  isLoading: false,
  error: null as unknown,
}));
vi.mock("../../data/use-operator-inbox", () => ({ useOperatorInbox: () => state }));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
it("uses only explicit Gateway run-decision linkage and names incomplete evidence", async () => {
  state.data = {
    workspaceId: "default",
    counts: { needs_decision: { complete: false } },
    items: [
      {
        id: "a",
        group: "needs_decision",
        title: "Approve write",
        summary: "Recorded linked decision",
        source: { runId: "run-a" },
        href: "/inbox?approvalId=a",
      },
      { id: "unlinked", group: "needs_decision", title: "Unrelated", source: {}, href: "/inbox" },
    ],
  };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<WorkWaitingDecisions workspaceId="default" />);
  });
  expect(renderer.root.findAllByType("a").map((node) => node.props.href)).toEqual([
    "/inbox?approvalId=a",
    "/work/runs/run-a",
  ]);
  expect(JSON.stringify(renderer.toJSON())).toContain("couldn't be checked");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Unrelated");
  act(() => renderer.unmount());
});
it("shows decision source failures without treating them as no decisions", async () => {
  state.isError = true;
  state.error = new Error("Inbox unavailable");
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<WorkWaitingDecisions workspaceId="default" />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("Decisions unavailable");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("No decisions linked");
  act(() => renderer.unmount());
  state.isError = false;
});
it("leaves expired approvals out of Waiting on your decision, as Inbox does", async () => {
  state.data = {
    workspaceId: "default",
    counts: { needs_decision: { complete: true } },
    items: [
      {
        id: "old",
        group: "needs_decision",
        title: "Expired write",
        source: { runId: "run-old" },
        href: "/inbox?approvalId=old",
        expiresAt: "2020-01-01T00:00:00Z",
      },
      {
        id: "live",
        group: "needs_decision",
        title: "Live write",
        source: { runId: "run-live" },
        href: "/inbox?approvalId=live",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
  };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<WorkWaitingDecisions workspaceId="default" />);
  });
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("Live write");
  expect(text).not.toContain("Expired write");
  act(() => renderer.unmount());
});
it("drops a decision from the list when it expires, without waiting for the next Inbox read", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    state.data = {
      workspaceId: "default",
      counts: { needs_decision: { complete: true } },
      items: [
        {
          id: "soon",
          kind: "approval",
          group: "needs_decision",
          title: "Approve soon",
          summary: "Expires in a moment",
          expiresAt: "2026-10-22T12:00:10.000Z",
          source: { runId: "run-soon" },
          href: "/inbox?approvalId=soon",
        },
      ],
    };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<WorkWaitingDecisions workspaceId="default" />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Approve soon");
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Approve soon");
    act(() => renderer.unmount());
  } finally {
    vi.useRealTimers();
  }
});
