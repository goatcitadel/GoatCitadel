import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillHubOperatorListResponse } from "@goatcitadel/mission-control-shared/api/client";
import { SkillHubOperatorPanel } from "./SkillHubOperatorPanel";

const api = vi.hoisted(() => ({
  fetchSkillHubOperator: vi.fn(),
  createSkillHubOperatorApproval: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

beforeEach(() => {
  api.fetchSkillHubOperator.mockResolvedValue(projection());
  api.createSkillHubOperatorApproval.mockResolvedValue({
    schemaVersion: "goatcitadel.skill-hub-operator.v1",
    reused: false,
    operatorMessage: "Approval created. Runtime remains unchanged.",
    approval: {
      approvalId: "approval-install",
      operationId: "operation-install",
      operationKind: "install_inactive",
      status: "pending",
      createdAt: "2026-07-14T01:00:00.000Z",
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillHubOperatorPanel", () => {
  it("renders review-only truth, every lifecycle action, version-byte drift, audit floor, and permission diff", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SkillHubOperatorPanel workspaceId="workspace-1" onOpenApproval={vi.fn()} />);
    });

    const text = flattenText(renderer!.toJSON());
    expect(text).toContain("Skill Hub lifecycle");
    expect(text).toContain("Review only");
    expect(text).toContain("Install inactive");
    expect(text).toContain("Stage update");
    expect(text).toContain("Stage rollback");
    expect(text).toContain("Request activation");
    expect(text).toContain("Request revoke");
    expect(text).toContain("Same-version drift");
    expect(text).toContain("Audit downgrade blocked");
    expect(text).toContain("widened");
    expect(text).toContain("Source");
    expect(text).toContain("clawhub · clawhub/demo · clawhub:demo");
    expect(text).toContain("AUDIT_DOWNGRADE · PERMISSION_WIDENED · UPSTREAM_VERSION_BYTE_DRIFT");

    const install = renderer!.root.findByProps({ "data-testid": "skill-hub-install_inactive" });
    expect(install.props.disabled).toBe(true);
    expect(install.props.title).toContain("AUDIT_DOWNGRADE");
    renderer!.unmount();
  });

  it("creates an inactive-install approval over the selected snapshot and opens canonical approval detail", async () => {
    api.fetchSkillHubOperator.mockResolvedValue(projection({ blocked: false }));
    const onOpenApproval = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SkillHubOperatorPanel workspaceId="workspace-1" onOpenApproval={onOpenApproval} />);
    });
    const install = renderer!.root.findByProps({ "data-testid": "skill-hub-install_inactive" });
    expect(install.props.disabled).toBe(false);

    await act(async () => {
      await install.props.onClick();
    });

    expect(api.createSkillHubOperatorApproval).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      snapshotId: "snapshot-v2",
      operationKind: "install_inactive",
    });
    expect(onOpenApproval).toHaveBeenCalledWith("approval-install");
    expect(api.fetchSkillHubOperator).toHaveBeenCalledTimes(2);
    renderer!.unmount();
  });

  it("labels an active policy-blocked candidate separately from inactive candidates", async () => {
    api.fetchSkillHubOperator.mockResolvedValue(projection({ blocked: false, activeNonCallable: true }));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SkillHubOperatorPanel workspaceId="workspace-1" onOpenApproval={vi.fn()} />);
    });

    const text = flattenText(renderer!.toJSON());
    expect(text).toContain("Active, not callable");
    expect(text).toContain("Active candidate retained; callableCatalog policy currently blocks invocation");
    expect(text).not.toContain("Immutable inactive candidate retained");
    renderer!.unmount();
  });

  it("ignores a late prior-workspace response after the active workspace changes", async () => {
    const workspaceA = deferred<SkillHubOperatorListResponse>();
    const workspaceB = deferred<SkillHubOperatorListResponse>();
    api.fetchSkillHubOperator.mockImplementation(({ workspaceId }: { workspaceId: string }) =>
      workspaceId === "workspace-a" ? workspaceA.promise : workspaceB.promise,
    );
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SkillHubOperatorPanel workspaceId="workspace-a" onOpenApproval={vi.fn()} />);
    });
    await act(async () => {
      renderer!.update(<SkillHubOperatorPanel workspaceId="workspace-b" onOpenApproval={vi.fn()} />);
    });

    workspaceB.resolve(projectionForWorkspace("workspace-b", "clawhub:workspace-b"));
    await act(async () => {
      await workspaceB.promise;
    });
    expect(flattenText(renderer!.toJSON())).toContain("clawhub:workspace-b");

    workspaceA.resolve(projectionForWorkspace("workspace-a", "clawhub:workspace-a"));
    await act(async () => {
      await workspaceA.promise;
    });
    const finalText = flattenText(renderer!.toJSON());
    expect(finalText).toContain("clawhub:workspace-b");
    expect(finalText).not.toContain("clawhub:workspace-a");
    renderer!.unmount();
  });

  it("does not surface or open an approval created by a prior workspace after switching workspaces", async () => {
    const approval = deferred<Awaited<ReturnType<typeof api.createSkillHubOperatorApproval>>>();
    api.fetchSkillHubOperator.mockImplementation(({ workspaceId }: { workspaceId: string }) =>
      Promise.resolve(projectionForWorkspace(workspaceId, `clawhub:${workspaceId}`)),
    );
    api.createSkillHubOperatorApproval.mockReturnValue(approval.promise);
    const onOpenApproval = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SkillHubOperatorPanel workspaceId="workspace-a" onOpenApproval={onOpenApproval} />);
    });

    const install = renderer!.root.findByProps({ "data-testid": "skill-hub-install_inactive" });
    act(() => {
      install.props.onClick();
    });
    await act(async () => {
      renderer!.update(<SkillHubOperatorPanel workspaceId="workspace-b" onOpenApproval={onOpenApproval} />);
    });
    approval.resolve({
      schemaVersion: "goatcitadel.skill-hub-operator.v1",
      reused: false,
      operatorMessage: "Workspace A approval created.",
      approval: {
        approvalId: "approval-workspace-a",
        operationId: "operation-workspace-a",
        operationKind: "install_inactive",
        status: "pending",
        createdAt: "2026-07-14T01:00:00.000Z",
      },
    });
    await act(async () => {
      await approval.promise;
    });

    expect(api.createSkillHubOperatorApproval).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      snapshotId: "snapshot-v2",
      operationKind: "install_inactive",
    });
    expect(onOpenApproval).not.toHaveBeenCalled();
    expect(flattenText(renderer!.toJSON())).toContain("clawhub:workspace-b");
    expect(flattenText(renderer!.toJSON())).not.toContain("Workspace A approval created.");
    renderer!.unmount();
  });

  it("keeps snapshot detail and facts single-column at narrow and mobile widths", () => {
    const cssPath = fileURLToPath(new URL("../styles/07-settings-library.css", import.meta.url));
    const css = fs.readFileSync(cssPath, "utf8");
    expect(css).toMatch(/@media \(max-width: 960px\)[\s\S]*\.mc-next-skill-hub-layout[\s\S]*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]*\.mc-next-skill-hub-facts[\s\S]*minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.mc-next-skill-hub-facts dd[\s\S]*overflow-wrap: anywhere/);
  });
});

function projection(options: { blocked?: boolean; activeNonCallable?: boolean } = {}): SkillHubOperatorListResponse {
  const blocked = options.blocked ?? true;
  const activeNonCallable = options.activeNonCallable ?? false;
  const mutationBlockers = blocked ? ["AUDIT_DOWNGRADE", "PERMISSION_WIDENED", "SNAPSHOT_NOT_CANDIDATE"] : [];
  return {
    schemaVersion: "goatcitadel.skill-hub-operator.v1",
    workspaceId: "workspace-1",
    generatedAt: "2026-07-14T01:00:00.000Z",
    page: { limit: 100, returned: 1, truncated: false, candidateInventoryTruncated: false },
    summary: {
      snapshots: 1,
      retainedCandidates: activeNonCallable ? 1 : 0,
      inactive: 0,
      callable: 0,
      blocked: blocked ? 1 : 0,
      pendingApprovals: 0,
    },
    items: [
      {
        snapshotId: "snapshot-v2",
        skillId: "extra:demo",
        title: "demo",
        ...(activeNonCallable
          ? {
              candidate: {
                candidateId: "candidate-demo",
                versionId: "version-demo",
                lifecycleState: "approved" as const,
                createdAt: "2026-07-14T00:00:00.000Z",
                updatedAt: "2026-07-14T00:00:00.000Z",
              },
            }
          : {}),
        lineage: {
          versionCount: activeNonCallable ? 1 : 0,
          latestVersionId: activeNonCallable ? "version-demo" : undefined,
          activeVersionId: activeNonCallable ? "version-demo" : undefined,
          inventoryTruncated: false,
          ambiguous: false,
        },
        snapshot: {
          operation: "review",
          sourceProvider: "clawhub",
          sourceType: "registry",
          sourceRef: "clawhub:demo",
          canonicalSourceKey: "clawhub/demo",
          declaredVersion: "1.0.0",
          resolvedVersion: "commit-v2",
          contentTreeSha256: "2".repeat(64),
          priorSnapshotId: "snapshot-v1",
          digestChangedFromPrior: true,
          sameVersionDifferentBytes: blocked,
          sameVersionDriftSnapshotId: blocked ? "snapshot-v1" : undefined,
          riskLevel: blocked ? "high" : "low",
          trustDisposition: blocked ? "blocked" : "candidate",
          blockerCodes: blocked ? ["AUDIT_DOWNGRADE", "PERMISSION_WIDENED", "UPSTREAM_VERSION_BYTE_DRIFT"] : [],
          audit: {
            policyId: "skill-import",
            policyVersion: "1.0.0",
            policyRevision: 1,
            scanners: [{ scannerId: "static" }],
            findingCodes: ["UNSAFE_SCRIPT"],
          },
          auditSha256: "3".repeat(64),
          auditFloor: { policyRevision: 2 },
          auditFloorSha256: "4".repeat(64),
          permissionEnvelope: { toolIds: ["shell.exec"] },
          permissionEnvelopeSha256: "5".repeat(64),
          permissionDiff: {
            disposition: blocked ? "widened" : "none",
            dimensions: { toolIds: { added: blocked ? ["shell.exec"] : [], removed: [] } },
          },
          compatibility: { compatible: true },
          createdAt: "2026-07-14T00:00:00.000Z",
        },
        artifact: {
          artifactId: "artifact-v2",
          manifestSha256: "6".repeat(64),
          fileCount: 4,
          totalBytes: 4096,
          createdAt: "2026-07-14T00:00:00.000Z",
        },
        runtime: {
          callable: false,
          activeVersion: activeNonCallable,
          inactiveCandidate: false,
        },
        approvals: {},
        actions: {
          install_inactive: { allowed: !blocked, blockers: mutationBlockers },
          stage_update_candidate: { allowed: false, blockers: ["CANDIDATE_LINEAGE_MISSING"] },
          stage_rollback_candidate: { allowed: false, blockers: ["CANDIDATE_LINEAGE_MISSING"] },
          activate: { allowed: false, blockers: ["INACTIVE_CANDIDATE_MISSING"] },
          revoke: { allowed: false, blockers: ["VERSION_NOT_ACTIVE"] },
        },
      },
    ],
  };
}

function projectionForWorkspace(workspaceId: string, sourceRef: string): SkillHubOperatorListResponse {
  const value = projection({ blocked: false });
  value.workspaceId = workspaceId;
  value.items[0]!.snapshot.sourceRef = sourceRef;
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as { children?: unknown };
  return flattenText(record.children);
}
