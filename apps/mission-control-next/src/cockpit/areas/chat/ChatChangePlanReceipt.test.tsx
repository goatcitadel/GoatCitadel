// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard", () => ({
  ChatChangePlanCard: ({ plan }: { plan: ChangePlanRecord }) => (
    <button type="button">{plan.status === "failed" ? "Details" : "Review current setup"}</button>
  ),
}));
vi.mock("./ChatChangePlanRecovery", () => ({
  ChatChangePlanRecovery: ({ plan }: { plan: ChangePlanRecord }) =>
    plan.status === "failed" ? <button type="button">Review again</button> : null,
}));
import { ChatChangePlanReceipt } from "./ChatChangePlanReceipt";
let root: Root | undefined, element: HTMLDivElement | undefined, composer: HTMLTextAreaElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  element?.remove();
  composer?.remove();
  root = undefined;
});
const oldPlan = {
  planId: "old",
  status: "failed",
  revision: 4,
  origin: { workspaceId: "A", sessionId: "s" },
} as ChangePlanRecord;
const nextPlan = { ...oldPlan, planId: "fresh", status: "awaiting_confirmation", revision: 1 } as ChangePlanRecord;
async function render(plan: ChangePlanRecord) {
  await act(async () =>
    root!.render(<ChatChangePlanReceipt receipt={{ plan }} sessionId="s" draftControls={{}} onUpdated={() => {}} />),
  );
}
async function mount() {
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  composer = document.createElement("textarea");
  composer.value = "Keep this draft";
  document.body.append(composer);
  await render(oldPlan);
  (
    Array.from(element.querySelectorAll("button")).find(
      (button) => button.textContent === "Review again",
    ) as HTMLButtonElement
  ).focus();
}
it("keeps focus when the canonical receipt replaces the entire recovery subtree", async () => {
  await mount();
  await render(nextPlan);
  expect(document.activeElement?.textContent).toBe("Review current setup");
});
it("preserves the composer focus and text chosen while renewal was pending", async () => {
  await mount();
  composer!.focus();
  await render(nextPlan);
  expect(document.activeElement).toBe(composer);
  expect(composer!.value).toBe("Keep this draft");
});
it("does not carry a previous workspace's focus intent into another scope", async () => {
  await mount();
  await render({ ...nextPlan, origin: { ...nextPlan.origin, workspaceId: "B" } });
  expect(document.activeElement).toBe(document.body);
});
