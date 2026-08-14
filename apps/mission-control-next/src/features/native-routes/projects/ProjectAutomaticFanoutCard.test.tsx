import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutonomousActivationGrantRecord, ChatProjectRecord } from "@goatcitadel/contracts";
import {
  createAutonomousActivationGrant,
  fetchAutonomousActivationGrants,
  revokeAutonomousActivationGrant,
} from "@goatcitadel/mission-control-shared/api/client";
import { ProjectAutomaticFanoutCard } from "./ProjectAutomaticFanoutCard";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  createAutonomousActivationGrant: vi.fn(),
  fetchAutonomousActivationGrants: vi.fn(),
  revokeAutonomousActivationGrant: vi.fn(),
}));

const mockedCreate = vi.mocked(createAutonomousActivationGrant);
const mockedFetch = vi.mocked(fetchAutonomousActivationGrants);
const mockedRevoke = vi.mocked(revokeAutonomousActivationGrant);

function project(): ChatProjectRecord {
  return {
    projectId: "project-1",
    workspaceId: "workspace-1",
    revision: 1,
    name: "Trusted project",
    description: "",
    workspacePath: "F:\\code\\personal-ai",
    lifecycleStatus: "active",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  } as ChatProjectRecord;
}

function grant(): AutonomousActivationGrantRecord {
  return {
    grantId: "grant-1",
    status: "active",
    workspaceId: "workspace-1",
    projectId: "project-1",
    surfaces: ["chat"],
    maxRiskLevel: "caution",
    capabilityPatterns: ["agent.fanout"],
    toolPatterns: ["agent.fanout"],
    activationKinds: ["subagent_fanout"],
    maxActivations: 3,
    usedActivations: 0,
    budgetUsd: 0.75,
    usedBudgetUsd: 0,
    grantor: "operator-1",
    reason: "temporary test authority",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("children" in node)) return "";
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(text))[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

async function render(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ProjectAutomaticFanoutCard project={project()} workspaceId="workspace-1" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

describe("ProjectAutomaticFanoutCard", () => {
  beforeEach(() => {
    mockedFetch.mockResolvedValue({ items: [] });
    mockedCreate.mockResolvedValue(grant());
    mockedRevoke.mockResolvedValue(grant());
  });

  it("creates only an exact active-project fan-out grant through accessible controls", async () => {
    const renderer = await render();
    const root = renderer.root;
    expect(root.findByProps({ "aria-label": "Automatic fan-out" })).toBeTruthy();
    expect(root.findByProps({ "aria-label": "Automatic fan-out grant expiry" })).toBeTruthy();
    await act(async () => {
      findButton(root, "Enable temporary automatic fan-out").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        projectId: "project-1",
        surfaces: ["chat"],
        activationKinds: ["subagent_fanout"],
        capabilityPatterns: ["agent.fanout"],
        toolPatterns: ["agent.fanout"],
        maxActivations: 3,
        budgetUsd: 0.75,
      }),
    );
    expect(collectText(root)).not.toContain('"projectId"');
  });

  it("shows active grant truth and provides immediate revocation", async () => {
    mockedFetch.mockResolvedValue({ items: [grant()] });
    const renderer = await render();
    const root = renderer.root;
    expect(collectText(root)).toContain("Active project grant");
    expect(collectText(root)).toContain("temporary test authority");
    await act(async () => {
      findButton(root, "Revoke now").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedRevoke).toHaveBeenCalledWith(
      "grant-1",
      expect.objectContaining({ reason: expect.stringMatching(/project/i) }),
    );
  });
});
