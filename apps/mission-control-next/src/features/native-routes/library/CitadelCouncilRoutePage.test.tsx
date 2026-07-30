import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelCouncilRoutePage } from "./CitadelCouncilRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  assignCitadelCouncilAgent: vi.fn(),
  fetchAgents: vi.fn(),
  listCitadelCouncil: vi.fn(),
  unassignCitadelCouncilAgent: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  assignCitadelCouncilAgent: apiMocks.assignCitadelCouncilAgent,
  fetchAgents: apiMocks.fetchAgents,
  listCitadelCouncil: apiMocks.listCitadelCouncil,
  unassignCitadelCouncilAgent: apiMocks.unassignCitadelCouncilAgent,
}));

function makeProps(): NativeRoutePagesProps {
  return {
    route: { area: "library", section: "citadel-council", theme: "library" },
    activeWorkspaceId: "default",
    activeWorkspaceName: "Acme",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  };
}

function treeString(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe("CitadelCouncilRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listCitadelCouncil.mockResolvedValue([]);
    apiMocks.fetchAgents.mockResolvedValue({
      items: [{ agentId: "research-agent", name: "Research", lifecycleStatus: "active" }],
    });
    apiMocks.assignCitadelCouncilAgent.mockResolvedValue({
      assignmentId: "a1",
      citadelId: "default",
      agentId: "research-agent",
      createdAt: "t",
    });
    apiMocks.unassignCitadelCouncilAgent.mockResolvedValue(undefined);
  });

  it("renders the Council header", () => {
    const markup = renderToStaticMarkup(<CitadelCouncilRoutePage {...makeProps()} />);
    expect(markup).toContain("Council");
  });

  it("lists seated agents by reference", async () => {
    apiMocks.listCitadelCouncil.mockResolvedValue([
      { assignmentId: "a1", citadelId: "default", agentId: "research-agent", createdAt: "t" },
    ]);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelCouncilRoutePage {...makeProps()} />);
    });
    expect(apiMocks.listCitadelCouncil).toHaveBeenCalledWith("default");
    expect(treeString(renderer!)).toContain("research-agent");
  });

  it("seats an existing agent into the active Citadel", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelCouncilRoutePage {...makeProps()} />);
    });
    const select = renderer!.root.findByType("select");
    act(() => {
      select.props.onChange({ target: { value: "research-agent" } });
    });
    const button = renderer!.root
      .findAllByType("button")
      .find((item) => (Array.isArray(item.props.children) ? item.props.children.includes("Seat") : false));
    await act(async () => {
      button?.props.onClick();
    });
    expect(apiMocks.assignCitadelCouncilAgent).toHaveBeenCalledWith("default", "research-agent");
  });

  it("shows an empty state when no agents are seated", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelCouncilRoutePage {...makeProps()} />);
    });
    expect(treeString(renderer!)).toContain("No agents seated yet");
  });

  it("associates the council agent select with a visible label", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelCouncilRoutePage {...makeProps()} />);
    });

    const select = renderer!.root.findByType("select");
    expect(select.props.id).toBeTruthy();

    const label = renderer!.root.findAllByType("label").find((node) => node.props.htmlFor === select.props.id);
    expect(label).toBeDefined();
    expect(treeString(renderer!)).toContain("Council agent");

    // A selected option is nested inside the wrapping label, so keep the
    // concise control name stable instead of letting its value join the name.
    expect(select.props["aria-label"]).toBe("Council agent");
  });
});
