import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitadelCouncilRoutePage } from "./CitadelCouncilRoutePage";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({ listCitadelCouncil: vi.fn() }));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  listCitadelCouncil: apiMocks.listCitadelCouncil,
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

  it("shows an empty state when no agents are seated", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<CitadelCouncilRoutePage {...makeProps()} />);
    });
    expect(treeString(renderer!)).toContain("No agents seated yet");
  });
});
