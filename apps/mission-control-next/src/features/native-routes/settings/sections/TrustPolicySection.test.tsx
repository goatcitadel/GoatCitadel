// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrustPolicySection } from "./TrustPolicySection";
import type { SettingsSectionProps } from "../SettingsShared";

const trustApi = vi.hoisted(() => ({
  fetchTrustPolicySnapshot: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/trust", () => ({
  fetchTrustPolicySnapshot: trustApi.fetchTrustPolicySnapshot,
}));

function makeProps(): SettingsSectionProps {
  return {
    route: { area: "settings", section: "trust-policy", theme: "settings" },
    section: "trust-policy",
    activeWorkspaceId: "workspace-a",
    activeWorkspaceName: "Workspace A",
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  };
}

function instanceText(node: ReactTestInstance | string): string {
  if (typeof node === "string") {
    return node;
  }
  return (node.children ?? []).map((child) => instanceText(child)).join(" ");
}

async function renderText(): Promise<string> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(<TrustPolicySection {...makeProps()} />);
  });
  return instanceText(renderer!.root);
}

describe("TrustPolicySection", () => {
  beforeEach(() => {
    trustApi.fetchTrustPolicySnapshot.mockReset();
    trustApi.fetchTrustPolicySnapshot.mockResolvedValue({
      generatedAt: "2026-06-20T12:00:00.000Z",
      readOnly: true,
      mutationSemantics: "none",
      enforcementSources: ["tools.grants", "skills.lifecycle"],
      sources: [
        { key: "toolGrants", owner: "tools.grants", status: "available", itemCount: 1 },
        { key: "skills", owner: "skills.lifecycle", status: "available", itemCount: 1 },
      ],
      permissionProfiles: [],
      toolGrants: [
        {
          grantId: "grant-deny-shell",
          toolPattern: "shell.*",
          decision: "deny",
          posture: "blocked",
          scope: "workspace",
          source: "tools.grants",
          createdAt: "2026-06-20T11:00:00.000Z",
        },
      ],
      localOperatorOverrides: [],
      capabilities: { inspectable: [], callable: [] },
      mcpServers: [],
      skills: [
        {
          skillId: "skill-candidate",
          name: "Candidate Skill",
          sourceKind: "extra",
          state: "enabled",
          lifecycleState: "candidate",
          callable: false,
          posture: "non_callable",
          declaredTools: ["memory.search"],
          requires: ["operator review"],
          source: "skills.lifecycle",
        },
      ],
      addons: [],
      lastUseEvidence: [],
    });
  });

  it("renders owner actions for trust rows without mutating policy", async () => {
    const text = await renderText();

    expect(text).toContain("Owner action");
    expect(text).toContain("Settings / Tools");
    expect(text).toContain("Resolve the blocker in the owner surface before runtime use.");
    expect(text).toContain("Library / Skills");
    expect(text).toContain("Evaluate and approve through the owner lifecycle before promotion.");
    expect(text).toContain("No last-use evidence");
  });

  it("labels trust matrix cells for compact card layout", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(<TrustPolicySection {...makeProps()} />);
    });

    const cells = renderer!.root.findAll((node) => node.type === "td" && typeof node.props["data-label"] === "string");

    expect(cells.map((cell) => cell.props["data-label"])).toContain("Owner action");
    expect(cells.map((cell) => cell.props["data-label"])).toContain("Last-use evidence");
  });
});
