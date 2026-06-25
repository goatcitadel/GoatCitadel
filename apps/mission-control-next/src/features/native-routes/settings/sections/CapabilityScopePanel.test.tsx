// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityScopePanel } from "./CapabilityScopePanel";
import type { CapabilityScopeView } from "@goatcitadel/contracts";

const apiMocks = vi.hoisted(() => ({
  fetchWorkspaceCapabilities: vi.fn(),
  updateWorkspaceCapabilities: vi.fn(),
  resetWorkspaceCapabilities: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchWorkspaceCapabilities: apiMocks.fetchWorkspaceCapabilities,
  updateWorkspaceCapabilities: apiMocks.updateWorkspaceCapabilities,
  resetWorkspaceCapabilities: apiMocks.resetWorkspaceCapabilities,
}));

function makeInheritView(): CapabilityScopeView {
  return {
    scopeKind: "workspace",
    scopeId: "ws-1",
    resourceType: "skill",
    mode: "inherit",
    items: [
      { resourceRef: "skill-a", label: "Skill Alpha", enabled: true, available: true, inherited: true },
      { resourceRef: "skill-b", label: "Skill Beta", enabled: true, available: true, inherited: true },
    ],
    effectiveRefs: ["skill-a", "skill-b"],
  };
}

function makeCuratedView(): CapabilityScopeView {
  return {
    scopeKind: "workspace",
    scopeId: "ws-1",
    resourceType: "skill",
    mode: "curated",
    items: [
      { resourceRef: "skill-a", label: "Skill Alpha", enabled: true, available: true, inherited: false },
      { resourceRef: "skill-b", label: "Skill Beta", enabled: false, available: true, inherited: false },
      { resourceRef: "skill-stale", label: "Stale Skill", enabled: true, available: false, inherited: false },
    ],
    effectiveRefs: ["skill-a"],
  };
}

function instanceText(node: ReactTestInstance | string): string {
  if (typeof node === "string") {
    return node;
  }
  return (node.children ?? []).map((child) => instanceText(child)).join(" ");
}

async function renderPanel(view: CapabilityScopeView): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(
      <CapabilityScopePanel
        scopeKind="workspace"
        scopeId="ws-1"
        resourceType="skill"
        title="Skills"
        fetchScope={() => Promise.resolve(view)}
        updateScope={apiMocks.updateWorkspaceCapabilities}
        resetScope={() => Promise.resolve(view)}
      />,
    );
  });
  return renderer!;
}

describe("CapabilityScopePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchWorkspaceCapabilities.mockResolvedValue(makeInheritView());
    apiMocks.updateWorkspaceCapabilities.mockResolvedValue(makeCuratedView());
    apiMocks.resetWorkspaceCapabilities.mockResolvedValue(makeInheritView());
  });

  it("renders item labels from the view", async () => {
    const renderer = await renderPanel(makeInheritView());
    const text = instanceText(renderer.root);
    expect(text).toContain("Skill Alpha");
    expect(text).toContain("Skill Beta");
  });

  it("shows inherited badge when mode is inherit", async () => {
    const renderer = await renderPanel(makeInheritView());
    const text = instanceText(renderer.root);
    expect(text).toContain("Inherited");
  });

  it("shows Curated label when mode is curated", async () => {
    const renderer = await renderPanel(makeCuratedView());
    const text = instanceText(renderer.root);
    expect(text).toContain("Curated");
  });

  it("shows unavailable note for stale items in curated mode", async () => {
    const renderer = await renderPanel(makeCuratedView());
    const text = instanceText(renderer.root);
    expect(text).toContain("unavailable");
  });

  it("renders a Save button", async () => {
    const renderer = await renderPanel(makeInheritView());
    const buttons = renderer.root.findAll(
      (node) => node.type === "button" && instanceText(node).includes("Save"),
    );
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("renders a Reset to inherited button", async () => {
    const renderer = await renderPanel(makeInheritView());
    const buttons = renderer.root.findAll(
      (node) => node.type === "button" && instanceText(node).includes("Reset"),
    );
    expect(buttons.length).toBeGreaterThan(0);
  });
});
