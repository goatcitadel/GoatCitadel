import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshCapabilityPanel } from "./MeshCapabilityPanel";

const hookState = vi.hoisted(() => ({
  inspection: null as unknown,
  invocationActivity: [] as unknown[],
  loading: false,
  error: null as string | null,
  activityError: null as string | null,
  reload: vi.fn(async () => undefined),
}));

const apiMocks = vi.hoisted(() => ({
  requestMeshCapabilityActivation: vi.fn(),
  revokeMeshCapabilityActivation: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useMeshCapabilityOps", () => ({
  useMeshCapabilityOps: () => hookState,
}));

vi.mock("@goatcitadel/mission-control-shared/api/mesh-capabilities", () => ({
  requestMeshCapabilityActivation: apiMocks.requestMeshCapabilityActivation,
  revokeMeshCapabilityActivation: apiMocks.revokeMeshCapabilityActivation,
}));

afterEach(() => {
  hookState.inspection = null;
  hookState.invocationActivity = [];
  hookState.loading = false;
  hookState.error = null;
  hookState.activityError = null;
  hookState.reload.mockClear();
  apiMocks.requestMeshCapabilityActivation.mockReset();
  apiMocks.revokeMeshCapabilityActivation.mockReset();
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const ACTIVATION_ID = `mesh-activation-${"d".repeat(48)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function activationResponse(approvalId: string) {
  return {
    replayed: false,
    activationId: ACTIVATION_ID,
    activationRevision: 1,
    approvalId,
    approvalStatus: "pending",
    approvalExpiresAt: "2026-07-23T10:15:00.000Z",
    diff: {
      permissionDisposition: "initial",
      permissionsAdded: ["filesystemRead:workspace://project"],
      permissionsRemoved: [],
      effectDisposition: "initial",
      currentEffectPosture: "unknown",
    },
  };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: "node-a",
    admissionGeneration: 1,
    publisherGeneration: 2,
    manifestSha256: SHA_A,
    entrySha256: SHA_B,
    localId: "project.status",
    capabilityKind: "tool",
    status: "review_required",
    reasons: ["operator_review_required"],
    effectPosture: "unknown",
    ...overrides,
  };
}

function inspection(entries: Record<string, unknown>[]): void {
  hookState.inspection = {
    workspaceId: "default",
    generatedAt: "2026-07-23T10:00:00.000Z",
    manifests: [
      {
        publicationKey: "publication-1",
        manifestSha256: SHA_A,
        admissionGeneration: 1,
        publisherGeneration: 2,
        createdAt: "2026-07-22T10:00:00.000Z",
        entries,
      },
    ],
  };
}

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    throw new Error(`Missing button ${label}`);
  }
  return button;
}

describe("MeshCapabilityPanel", () => {
  it("renders publisher identity, digest facts, posture, health/lease reasons, and callable state without raw manifest JSON", () => {
    inspection([
      entry(),
      entry({
        localId: "files.read",
        entrySha256: SHA_C,
        capabilityKind: "mcp_server",
        status: "offline",
        reasons: ["publication_lease_expired"],
        effectPosture: "read_only",
      }),
    ]);
    const markup = renderToStaticMarkup(<MeshCapabilityPanel workspaceId="default" />);

    expect(markup).toContain("Mesh capability publications");
    expect(markup).toContain("Node node-a");
    expect(markup).toContain("Publisher generation 2");
    expect(markup).toContain("Admission generation 1");
    expect(markup).toContain(`sha256:${SHA_A.slice(0, 12)}…`);
    expect(markup).toContain("project.status");
    expect(markup).toContain("mesh:node-a:tool:project.status");
    expect(markup).toContain("Review required");
    expect(markup).toContain("Inspect only");
    expect(markup).toContain("Awaiting operator review; publication alone never grants callability.");
    expect(markup).toContain("MCP server");
    expect(markup).toContain("Offline");
    expect(markup).toContain("The capability-publication lease expired; the publisher must re-acquire it.");
    // Unknown effect posture is disclosed verbatim, never upgraded.
    expect(markup).toContain("Effects: unknown");
    // Semantic UI only: no raw manifest/schema JSON, field names, or braces.
    expect(markup).not.toContain("descriptorSha256");
    expect(markup).not.toContain("inputSchema");
    expect(markup).not.toContain("schemaVersion");
    expect(markup).not.toContain("{&quot;");
    expect(markup).not.toContain("&quot;:");
  });

  it("shows activation linkage and offers revoke only for a live activation, with callable state for active entries", () => {
    inspection([
      entry({
        status: "active",
        reasons: ["activation_live"],
        effectPosture: "read_only",
        activation: {
          activationId: ACTIVATION_ID,
          activationRevision: 3,
          approvalId: "3b1e8a10-0000-4000-8000-000000000001",
          revoked: false,
        },
      }),
    ]);
    const markup = renderToStaticMarkup(<MeshCapabilityPanel workspaceId="default" />);
    expect(markup).toContain("Callable");
    expect(markup).toContain("revision 3");
    expect(markup).toContain(ACTIVATION_ID.slice(0, 18));
    expect(markup).toContain("3b1e8a10-0000-4000");
    expect(markup).toContain("Revoke activation");
    expect(markup).toContain("Revocation reason");
    // Active entries do not re-offer the request action.
    expect(markup).not.toContain("Request activation");
  });

  it("requests activation with the exact entry binding and renders the semantic diff receipt", async () => {
    inspection([entry()]);
    apiMocks.requestMeshCapabilityActivation.mockResolvedValueOnce(
      activationResponse("3b1e8a10-0000-4000-8000-000000000001"),
    );
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<MeshCapabilityPanel workspaceId="default" />);
    });
    await act(async () => {
      findButton(renderer!.root, "Request activation").props.onClick();
    });
    expect(apiMocks.requestMeshCapabilityActivation).toHaveBeenCalledWith({
      workspaceId: "default",
      capabilityId: "mesh:node-a:tool:project.status",
      manifestSha256: SHA_A,
      entrySha256: SHA_B,
    });
    expect(hookState.reload).toHaveBeenCalledTimes(1);
    const text = collectText(renderer!.root);
    expect(text).toContain("Approval requested");
    expect(text).toContain("Approval pending");
    expect(text).toContain("1 added, 0 removed");
    expect(text).toContain("unknown");
    renderer!.unmount();
  });

  it("ignores a prior-workspace activation receipt without clearing the newer workspace action", async () => {
    inspection([entry()]);
    const activationA = deferred<ReturnType<typeof activationResponse>>();
    const activationB = deferred<ReturnType<typeof activationResponse>>();
    apiMocks.requestMeshCapabilityActivation.mockImplementation(({ workspaceId }: { workspaceId: string }) =>
      workspaceId === "workspace-a" ? activationA.promise : activationB.promise,
    );
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<MeshCapabilityPanel workspaceId="workspace-a" />);
    });
    await act(async () => {
      findButton(renderer!.root, "Request activation").props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.update(<MeshCapabilityPanel workspaceId="workspace-b" />);
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer!.root, "Request activation").props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      activationA.resolve(activationResponse("workspace-a-approval"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(collectText(renderer!.root)).toContain("Requesting…");
    expect(collectText(renderer!.root)).not.toContain("workspace-a");
    expect(hookState.reload).not.toHaveBeenCalled();

    await act(async () => {
      activationB.resolve(activationResponse("workspace-b-approval"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(collectText(renderer!.root)).toContain("Approval requested");
    expect(collectText(renderer!.root)).toContain("workspace-b-approv");
    expect(collectText(renderer!.root)).not.toContain("workspace-a");
    expect(hookState.reload).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it("keeps revoke disabled until a reason is entered and then revokes with that reason", async () => {
    inspection([
      entry({
        status: "active",
        reasons: ["activation_live"],
        activation: {
          activationId: ACTIVATION_ID,
          activationRevision: 1,
          approvalId: "3b1e8a10-0000-4000-8000-000000000001",
          revoked: false,
        },
      }),
    ]);
    apiMocks.revokeMeshCapabilityActivation.mockResolvedValueOnce({
      replayed: false,
      activationId: ACTIVATION_ID,
      reason: "Operator withdrew the grant.",
      revokedAt: "2026-07-23T10:20:00.000Z",
    });
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<MeshCapabilityPanel workspaceId="default" />);
    });
    const revokeButton = findButton(renderer!.root, "Revoke activation");
    expect(revokeButton.props.disabled).toBe(true);
    const reasonInput = renderer!.root.findAll((node) => node.type === "input")[0]!;
    act(() => {
      reasonInput.props.onChange({ target: { value: "Operator withdrew the grant." } });
    });
    expect(findButton(renderer!.root, "Revoke activation").props.disabled).toBe(false);
    await act(async () => {
      findButton(renderer!.root, "Revoke activation").props.onClick();
    });
    expect(apiMocks.revokeMeshCapabilityActivation).toHaveBeenCalledWith({
      workspaceId: "default",
      activationId: ACTIVATION_ID,
      reason: "Operator withdrew the grant.",
    });
    expect(hookState.reload).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it("never offers activation for skill descriptors and explains the staged lifecycle instead", () => {
    inspection([
      entry({
        localId: "project.guide",
        capabilityKind: "skill",
        reasons: ["operator_review_required", "skill_descriptor_never_callable"],
      }),
    ]);
    const markup = renderToStaticMarkup(<MeshCapabilityPanel workspaceId="default" />);
    expect(markup).not.toContain("Request activation");
    expect(markup).toContain("Skill descriptors are never callable from the catalog.");
    expect(markup).toContain("governed skill");
  });

  it("discloses invocation outcomes honestly, flags manual reconciliation, and states the read-only boundary", () => {
    inspection([entry()]);
    hookState.invocationActivity = [
      {
        invocationId: "mesh-invocation-1",
        capabilityId: "mesh:node-a:tool:project.status",
        nodeId: "node-a",
        phase: "settled",
        disposition: "unknown",
        settlementAuthority: "gateway",
        errorCode: "mesh_capability_dispatch_deadline_expired",
        manualReconciliationRequired: true,
        observedAt: "2026-07-23T10:00:00.000Z",
      },
      {
        invocationId: "mesh-invocation-2",
        capabilityId: "mesh:node-a:tool:project.status",
        nodeId: "node-a",
        phase: "settled",
        disposition: "succeeded",
        settlementAuthority: "node",
        manualReconciliationRequired: false,
        observedAt: "2026-07-23T10:01:00.000Z",
      },
    ];
    const markup = renderToStaticMarkup(<MeshCapabilityPanel workspaceId="default" />);
    expect(markup).toContain("Invocation outcomes (2)");
    expect(markup).toContain("Settled: unknown");
    expect(markup).toContain("Manual reconciliation required");
    expect(markup).toContain("Settled by gateway");
    expect(markup).toContain("Settled: succeeded");
    expect(markup).toContain("Automatic replay is suppressed.");
    expect(markup).toContain("read-only observability");
    expect(markup).toContain("never acknowledges or replays anything");
  });

  it("reports unavailable truth without inventing state", () => {
    hookState.error = "The mesh capability publication inspection is unavailable.";
    hookState.activityError = "Recent mesh invocation activity is unavailable.";
    const markup = renderToStaticMarkup(<MeshCapabilityPanel workspaceId="default" />);
    expect(markup).toContain("The mesh capability publication inspection is unavailable.");
    expect(markup).toContain("Recent mesh invocation activity is unavailable.");
    // No entry state is invented while canonical truth is unavailable.
    expect(markup).not.toContain("Inspect only");
    expect(markup).not.toContain("project.status");
  });

  it("uses canonical shell tokens with responsive, wrap-safe layout in the panel stylesheet", () => {
    const cssPath = fileURLToPath(new URL("./mesh-capabilities.css", import.meta.url));
    const css = fs.readFileSync(cssPath, "utf8");
    expect(css).toMatch(/\.mc-next-mesh-caps-entry\s*{[^}]*border-inline-start-color: var\(--accent\);/s);
    expect(css).toMatch(/\.mc-next-mesh-caps-entry\[data-status="active"\]\s*{[^}]*var\(--gc-risk-safe\)/s);
    expect(css).toMatch(/\.mc-next-mesh-caps-entry\[data-status="blocked"\][^{]*{[^}]*var\(--gc-risk-danger\)/s);
    expect(css).toMatch(/overflow-wrap: anywhere/);
    expect(css).toMatch(/@media \(max-width: 860px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*flex-direction: column/);
    // Canonical tokens only — the dead --mc-accent variable must not appear.
    expect(css).not.toMatch(/--mc-accent/);
  });
});
