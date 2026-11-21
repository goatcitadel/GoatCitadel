// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
vi.mock("./ChatExpiredApprovalRecoveryControl", () => ({ ChatExpiredApprovalRecoveryControl: (props: Record<string, unknown>) => <div data-recovery={JSON.stringify(props)} /> }));
import { ChatChangePlanRecovery } from "./ChatChangePlanRecovery";
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; });
const plan = { planId: "expired-setup", kind: "runtime_configuration", status: "failed", approvalRefs: ["older", "expired-exact"], origin: { workspaceId: "A", sessionId: "s", turnId: "t" } } as unknown as ChangePlanRecord;
it("reaches the canonical recovery owner from a failed Chat setup receipt", async () => {
  await act(async () => { tree = create(<ChatChangePlanRecovery plan={plan} sessionId="s" draftControls={{ draft: "Keep my unfinished message" }} onUpdated={() => {}} />); });
  const data = JSON.parse(tree!.root.findByType("div").props["data-recovery"]);
  expect(data).toMatchObject({ sessionId: "s", workspaceId: "A", approvalId: "expired-exact", turnId: "t", showExpiredNotice: false, props: { draft: "Keep my unfinished message" } });
});
it.each([
  ["completed", { ...plan, status: "completed" }, "s", undefined],
  ["awaiting approval", { ...plan, status: "awaiting_approval" }, "s", undefined],
  ["unsupported family", { ...plan, kind: "provider_connection" }, "s", undefined],
  ["missing approval", { ...plan, approvalRefs: [] }, "s", undefined],
  ["legacy missing approval identity", { ...plan, approvalRefs: undefined }, "s", undefined],
  ["legacy missing scope", { ...plan, origin: undefined }, "s", undefined],
  ["foreign conversation", plan, "other", undefined],
  ["already visible tool recovery", plan, "s", "expired-exact"],
] as const)("does not invent or duplicate renewal for %s", async (_name, candidate, sessionId, pendingApprovalId) => {
  await act(async () => { tree = create(<ChatChangePlanRecovery plan={candidate as ChangePlanRecord} sessionId={sessionId} pendingApprovalId={pendingApprovalId} draftControls={{}} onUpdated={() => {}} />); });
  expect(tree!.toJSON()).toBeNull();
});
