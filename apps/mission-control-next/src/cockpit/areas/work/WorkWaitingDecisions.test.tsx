import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { WorkWaitingDecisions } from "./WorkWaitingDecisions";
const state = vi.hoisted(() => ({ data: undefined as unknown, isError: false, isLoading: false, error: null as unknown }));
vi.mock("../../data/use-operator-inbox", () => ({ useOperatorInbox: () => state }));
vi.mock("../../ui/NativeOwnerLink", () => ({ NativeOwnerLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
it("uses only explicit Gateway run-decision linkage and names incomplete evidence", async () => {
  state.data = { workspaceId: "default", counts: { needs_decision: { complete: false } }, items: [{ id: "a", group: "needs_decision", title: "Approve write", summary: "Recorded linked decision", source: { runId: "run-a" }, href: "/inbox?approvalId=a" }, { id: "unlinked", group: "needs_decision", title: "Unrelated", source: {}, href: "/inbox" }] };
  let renderer!: ReturnType<typeof create>; await act(async () => { renderer = create(<WorkWaitingDecisions workspaceId="default" />); });
  expect(renderer.root.findAllByType("a").map(node => node.props.href)).toEqual(["/inbox?approvalId=a", "/work/runs/run-a"]); expect(JSON.stringify(renderer.toJSON())).toContain("coverage is incomplete"); expect(JSON.stringify(renderer.toJSON())).not.toContain("Unrelated"); act(() => renderer.unmount());
});
it("shows decision source failures without treating them as no decisions", async () => {
  state.isError = true; state.error = new Error("Inbox unavailable");
  let renderer!: ReturnType<typeof create>; await act(async () => { renderer = create(<WorkWaitingDecisions workspaceId="default" />); });
  expect(JSON.stringify(renderer.toJSON())).toContain("Decision linkage unavailable"); expect(JSON.stringify(renderer.toJSON())).not.toContain("No run-linked decisions"); act(() => renderer.unmount()); state.isError = false;
});
