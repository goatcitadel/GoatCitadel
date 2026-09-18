import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelCouncilRoutePage } from "./CitadelCouncilRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  assignCitadelCouncilAgent: vi.fn(),
  fetchAgents: vi.fn(),
  listCitadelCouncil: vi.fn(),
  getCitadelAccessSnapshot: vi.fn(),
  unassignCitadelCouncilAgent: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  assignCitadelCouncilAgent: apiMocks.assignCitadelCouncilAgent,
  fetchAgents: apiMocks.fetchAgents,
  listCitadelCouncil: apiMocks.listCitadelCouncil,
  getCitadelAccessSnapshot: apiMocks.getCitadelAccessSnapshot,
  isApiRequestError: (error: { status?: number }) => typeof error?.status === "number",
  unassignCitadelCouncilAgent: apiMocks.unassignCitadelCouncilAgent,
}));

const revision = "a".repeat(64);
function snapshot(items: CitadelAccessSnapshot["council"] = [], rev = revision, citadelId = "default"): CitadelAccessSnapshot {
  return { citadelId, revision: rev, structure: { citadelId, revision: "s".repeat(64), charter: null, chambers: [] }, wards: [], passages: [], members: [], integrations: [], council: items };
}

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
    apiMocks.getCitadelAccessSnapshot.mockImplementation(async (id: string) => snapshot(await apiMocks.listCitadelCouncil(id), revision, id));
    apiMocks.fetchAgents.mockResolvedValue({
      items: [{ agentId: "research-agent", name: "Research", lifecycleStatus: "active" }],
    });
    apiMocks.assignCitadelCouncilAgent.mockResolvedValue(snapshot([{
      assignmentId: "a1",
      citadelId: "default",
      agentId: "research-agent",
      createdAt: "t",
    }], "b".repeat(64)));
    apiMocks.unassignCitadelCouncilAgent.mockResolvedValue(snapshot([], "b".repeat(64)));
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
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Inspect Research" }).props.onClick(); });
    expect(renderer!.root.findAllByType("code").map((node) => node.props["aria-label"])).toEqual(
      expect.arrayContaining(["Agent identifier: research-agent", "Seat identifier: a1"]),
    );
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
    expect(apiMocks.assignCitadelCouncilAgent).toHaveBeenCalledWith("default", "research-agent", revision);
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

  it("preserves the selected agent on conflict, requires review, and never refetches over its acknowledgement", async () => {
    const peer = { ...snapshot([], "b".repeat(64)), members: [{ memberId: "m", citadelId: "default", subjectId: "peer", role: "viewer" as const, createdAt: "t", updatedAt: "t" }] };
    apiMocks.getCitadelAccessSnapshot.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(peer);
    apiMocks.assignCitadelCouncilAgent.mockRejectedValueOnce(Object.assign(new Error("Changed"), { status: 409 }));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<CitadelCouncilRoutePage {...makeProps()} />); });
    const seat = () => renderer.root.findAllByType("button").find((item) => Array.isArray(item.props.children) && item.props.children.includes("Seat"))!;
    await act(async () => { await seat().props.onClick(); });
    expect(renderer.root.findByType("select").props.value).toBe("research-agent");
    expect(seat().props.disabled).toBe(true);
    expect(treeString(renderer)).toContain("peer");
    await act(async () => { await seat().props.onClick(); });
    expect(apiMocks.assignCitadelCouncilAgent).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.root.findAllByType("button").find((item) => item.props.children === "Use current access review")!.props.onClick(); });
    expect(apiMocks.assignCitadelCouncilAgent).toHaveBeenCalledTimes(1);
    await act(async () => { await seat().props.onClick(); });
    expect(apiMocks.assignCitadelCouncilAgent).toHaveBeenLastCalledWith("default", "research-agent", peer.revision);
    expect(apiMocks.getCitadelAccessSnapshot).toHaveBeenCalledTimes(2);
    expect(treeString(renderer)).toContain("Agent seated in this Citadel.");
    act(() => renderer.unmount());
  });
});
