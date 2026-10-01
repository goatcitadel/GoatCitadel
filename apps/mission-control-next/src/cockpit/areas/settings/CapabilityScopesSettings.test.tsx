import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CapabilityResourceType,
  CapabilityScopeReviewedUpdateInput,
  CapabilityScopeView,
} from "@goatcitadel/contracts";
import { CapabilityScopesSettings } from "./CapabilityScopesSettings";
import { __resetCapabilityScopeAttemptsForTests } from "../../../features/native-routes/settings/capability-scope-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), reset: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchCitadelCapabilities: api.read,
  fetchWorkspaceCapabilities: api.read,
  updateReviewedCapabilities: api.save,
  resetReviewedCapabilities: api.reset,
  isApiRequestError: () => false,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));
let renderer: ReactTestRenderer | undefined, views: Record<CapabilityResourceType, CapabilityScopeView>;
function view(type: CapabilityResourceType, count = 2): CapabilityScopeView {
  return {
    scopeKind: "citadel",
    scopeId: "citadel",
    resourceType: type,
    mode: "inherit",
    effectiveRefs: [],
    items: Array.from({ length: count }, (_, index) => ({
      resourceRef: `${type}-${index}`,
      label: `Reference ${index}`,
      enabled: true,
      available: true,
      inherited: true,
    })),
    selectionReview: {
      version: "capability_scope_selection.v1",
      revision: "a".repeat(64),
      scopeKind: "citadel",
      scopeId: "citadel",
      resourceType: type,
      citadelId: "citadel",
      scopeLifecycleStatus: "active",
      citadelLifecycleStatus: "active",
      assignments: [],
    },
  };
}
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join(" ");
}
function button(node: ReactTestInstance, label: string) {
  return node.findAllByType("button").find((item) => text(item).replace(/\s+/gu, " ").trim() === label)!;
}
function panel(label = "Skills selection") {
  return renderer!.root.findAllByType("section").find((item) => item.props["aria-label"] === label)!;
}
async function mount() {
  await act(async () => {
    renderer = create(<CapabilityScopesSettings scopeKind="citadel" scopeId="citadel" />);
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetCapabilityScopeAttemptsForTests();
  __resetSessionDraftsForTests();
  views = { skill: view("skill"), integration: view("integration"), mcp_server: view("mcp_server") };
  api.read.mockImplementation(async (_id: string, type: CapabilityResourceType) => views[type]);
  api.save.mockImplementation(async (_kind: string, _id: string, input: CapabilityScopeReviewedUpdateInput) => {
    const before = views[input.resourceType],
      selectionReview = { ...before.selectionReview!, revision: "b".repeat(64), assignments: input.assignments };
    views[input.resourceType] = { ...before, mode: "curated", selectionReview };
    return { version: "capability_scope_receipt.v1", previousRevision: input.expectedRevision, selectionReview };
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
it("uses native bounded fields with truthful live availability and no implicit writes", async () => {
  views.skill = view("skill", 31);
  await mount();
  expect(panel().findAllByType("li")).toHaveLength(30);
  expect(text(renderer!.root)).toContain("do not install, enable, connect or invoke");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("mc-next-");
  expect(api.save).not.toHaveBeenCalled();
  await act(async () => button(panel(), "Show more references").props.onClick());
  expect(panel().findAllByType("li")).toHaveLength(31);
});
it("reviews and cancels with zero writes, then applies the exact native selection and confirms readback", async () => {
  await mount();
  await act(async () =>
    panel()
      .findAllByType("input")
      .find((item) => item.props.type === "checkbox")!
      .props.onChange(),
  );
  await act(async () => button(panel(), "Review selection").props.onClick());
  expect(panel("Review capability selection")).toBeDefined();
  expect(api.save).not.toHaveBeenCalled();
  await act(async () => button(panel("Review capability selection"), "Cancel scope review").props.onClick());
  expect(api.save).not.toHaveBeenCalled();
  await act(async () => button(panel(), "Review selection").props.onClick());
  await act(async () => button(panel("Review capability selection"), "Apply reviewed selection").props.onClick());
  expect(api.save).toHaveBeenCalledExactlyOnceWith("citadel", "citadel", {
    resourceType: "skill",
    expectedRevision: "a".repeat(64),
    assignments: [
      { resourceRef: "skill-0", enabled: false },
      { resourceRef: "skill-1", enabled: true },
    ],
  });
  expect(text(panel())).toContain("saved and confirmed");
});
it("keeps a lost write locked and its draft retained after native remount", async () => {
  await mount();
  await act(async () =>
    panel()
      .findAllByType("input")
      .find((item) => item.props.type === "checkbox")!
      .props.onChange(),
  );
  await act(async () => button(panel(), "Review selection").props.onClick());
  api.save.mockRejectedValueOnce(new Error("Lost response"));
  await act(async () => button(panel("Review capability selection"), "Apply reviewed selection").props.onClick());
  expect(text(panel("Review capability selection"))).toContain("outcome is unconfirmed");
  expect(button(panel("Review capability selection"), "Apply reviewed selection").props.disabled).toBe(true);
  await act(async () => renderer!.unmount());
  await mount();
  expect(button(panel(), "Review selection").props.disabled).toBe(true);
  expect(
    panel()
      .findAllByType("input")
      .find((item) => item.props.type === "checkbox")!.props.checked,
  ).toBe(false);
  expect(text(panel())).toContain("outcome is unconfirmed");
  expect(api.save).toHaveBeenCalledOnce();
});
it("shows an unsupported Gateway honestly and withholds all native selection actions", async () => {
  for (const value of Object.values(views)) value.selectionReview = undefined;
  await mount();
  expect(text(panel())).toContain("Reviewed editing is unavailable");
  expect(button(panel(), "Review selection").props.disabled).toBe(true);
  expect(
    panel()
      .findAllByType("input")
      .filter((item) => item.props.type === "checkbox")
      .every((item) => item.props.disabled),
  ).toBe(true);
  expect(api.save).not.toHaveBeenCalled();
  expect(api.reset).not.toHaveBeenCalled();
});
