// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityPackManifest } from "@goatcitadel/contracts";
import { PackExecutionPanel } from "./PackExecutionPanel";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), verify: vi.fn(), create: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  createChangePlan: mocks.create,
  fetchChangePlans: mocks.list,
  fetchChangePlan: mocks.get,
  verifyChangePlan: mocks.verify,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/OwnedChangePlanList", () => ({
  OwnedChangePlanList: ({ plans }: { plans: { planId: string; status: string }[] }) => (
    <div>
      {plans.map((plan) => (
        <p key={plan.planId}>
          {plan.planId}: {plan.status}
        </p>
      ))}
    </div>
  ),
}));
const manifest = {
  packId: "browser-qa-operator",
  assets: [],
  provenance: { contentHash: "a".repeat(64) },
} as unknown as CapabilityPackManifest;
const parent = {
  planId: "pack-plan",
  status: "monitoring",
  revision: 5,
  request: { kind: "capability_pack", packId: manifest.packId },
  evidenceRefs: ["change_plan:child-plan"],
};
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ items: [parent] });
  mocks.get.mockResolvedValue({ planId: "child-plan", status: "completed" });
  mocks.verify.mockResolvedValue({ ...parent, status: "completed", revision: 6 });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
async function render() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <PackExecutionPanel
        manifest={manifest}
        workspaceId="default"
        navigate={vi.fn()}
        route={{ area: "settings", section: "addons", theme: "dark" } as never}
      />,
    ),
  );
  return host;
}
describe("PackExecutionPanel owner verification", () => {
  it("loads without a mutation and verifies the exact monitoring revision on explicit refresh", async () => {
    const host = await render();
    expect(mocks.verify).not.toHaveBeenCalled();
    const refresh = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh execution status",
    )!;
    await act(async () => refresh.click());
    expect(mocks.verify).toHaveBeenCalledWith("pack-plan", { workspaceId: "default" }, 5);
    expect(host.textContent).toContain("pack-plan: completed");
    expect(host.textContent).toContain("child-plan: completed");
  });
  it("keeps the prior state and exposes a rejected verification without inventing readiness", async () => {
    mocks.verify.mockRejectedValue(new Error("The plan changed elsewhere; refresh its current revision."));
    const host = await render();
    const refresh = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh execution status",
    )!;
    await act(async () => refresh.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    expect(host.textContent).toContain("pack-plan: monitoring");
    expect(host.textContent).not.toContain("pack-plan: completed");
  });
});

it("ignores a late setup receipt after changing the owning pack", async () => {
  mocks.list.mockResolvedValue({ items: [] });
  let finish!: (value: unknown) => void;
  mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = {...manifest, assets: [{id: "asset-1", label: "Asset one", binding: {owner: "mcp"}}]} as CapabilityPackManifest;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const view = (value: CapabilityPackManifest) => <PackExecutionPanel manifest={value} workspaceId="default" navigate={vi.fn()} route={{area:"settings",section:"addons",theme:"dark"} as never} />;
  await act(async () => root.render(view(first)));
  const review = () => [...host.querySelectorAll("button")].find(button => button.textContent === "Review setup")!;
  await act(async () => review().click());
  expect(mocks.create).toHaveBeenCalledOnce();
  await act(async () => root.render(view({...first,packId:"second-pack"})));
  expect(review().disabled).toBe(false);
  await act(async () => finish({...parent,planId:"old-pack-receipt",status:"awaiting_confirmation",requiredAction:{kind:"confirmation"}}));
  expect(host.textContent).not.toContain("old-pack-receipt");
  expect(review().disabled).toBe(false);
});
