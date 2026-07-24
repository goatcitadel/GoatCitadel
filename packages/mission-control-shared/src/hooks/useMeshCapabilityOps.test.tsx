import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMeshCapabilityOps } from "./useMeshCapabilityOps";

const apiMocks = vi.hoisted(() => ({
  fetchMeshCapabilityPublications: vi.fn(),
  fetchMeshCapabilityInvocationActivity: vi.fn(),
}));

vi.mock("../api/mesh-capabilities", () => ({
  fetchMeshCapabilityPublications: apiMocks.fetchMeshCapabilityPublications,
  fetchMeshCapabilityInvocationActivity: apiMocks.fetchMeshCapabilityInvocationActivity,
}));
vi.mock("./useRefreshSubscription", () => ({ useRefreshSubscription: vi.fn() }));

type HookValue = ReturnType<typeof useMeshCapabilityOps>;

function Harness({ workspaceId, onValue }: { workspaceId: string; onValue: (value: HookValue) => void }) {
  onValue(useMeshCapabilityOps(workspaceId));
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function inspection(workspaceId: string) {
  return { workspaceId, generatedAt: "2026-07-23T10:00:00.000Z", manifests: [] };
}

describe("useMeshCapabilityOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchMeshCapabilityPublications.mockResolvedValue(inspection("default"));
    apiMocks.fetchMeshCapabilityInvocationActivity.mockResolvedValue([]);
  });

  it("loads the inspection and invocation activity for the workspace", async () => {
    apiMocks.fetchMeshCapabilityInvocationActivity.mockResolvedValueOnce([
      {
        invocationId: "mesh-invocation-1",
        capabilityId: "mesh:node-a:tool:project.status",
        nodeId: "node-a",
        phase: "settled",
        disposition: "succeeded",
        manualReconciliationRequired: false,
        observedAt: "2026-07-23T10:00:00.000Z",
      },
    ]);
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="default" onValue={(value) => (latest = value)} />);
    });
    await flush();
    expect(apiMocks.fetchMeshCapabilityPublications).toHaveBeenCalledWith("default");
    expect(apiMocks.fetchMeshCapabilityInvocationActivity).toHaveBeenCalledWith("default");
    expect(latest?.loading).toBe(false);
    expect(latest?.inspection?.workspaceId).toBe("default");
    expect(latest?.invocationActivity).toHaveLength(1);
    expect(latest?.error).toBeNull();
    expect(latest?.activityError).toBeNull();
    renderer!.unmount();
  });

  it("keeps inspection truth when only the activity read fails, and reports the gap", async () => {
    apiMocks.fetchMeshCapabilityInvocationActivity.mockRejectedValueOnce(new Error("boom"));
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="default" onValue={(value) => (latest = value)} />);
    });
    await flush();
    expect(latest?.inspection?.workspaceId).toBe("default");
    expect(latest?.error).toBeNull();
    expect(latest?.activityError).toMatch(/unavailable/u);
    expect(latest?.invocationActivity).toEqual([]);
    renderer!.unmount();
  });

  it("reports an unavailable inspection without inventing client-side state", async () => {
    apiMocks.fetchMeshCapabilityPublications.mockRejectedValueOnce(new Error("token=sk-secret-never-surfaced"));
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="default" onValue={(value) => (latest = value)} />);
    });
    await flush();
    expect(latest?.inspection).toBeNull();
    expect(latest?.error).toBe("The mesh capability publication inspection is unavailable.");
    expect(latest?.error).not.toContain("sk-secret");
    renderer!.unmount();
  });

  it("reloads on demand and ignores stale results after unmount", async () => {
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="default" onValue={(value) => (latest = value)} />);
    });
    await flush();
    apiMocks.fetchMeshCapabilityPublications.mockClear();
    await act(async () => {
      await latest!.reload();
    });
    expect(apiMocks.fetchMeshCapabilityPublications).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });
});
