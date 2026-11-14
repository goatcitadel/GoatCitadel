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

  it("hides previous results on the first workspace render and ignores stale reloads", async () => {
    const onValue = vi.fn<(value: HookValue) => void>();
    apiMocks.fetchMeshCapabilityPublications.mockResolvedValueOnce(inspection("workspace-a"));
    apiMocks.fetchMeshCapabilityInvocationActivity.mockResolvedValueOnce([
      {
        invocationId: "workspace-a-invocation",
        capabilityId: "mesh:node-a:tool:project.status",
        nodeId: "node-a",
        phase: "settled",
        disposition: "succeeded",
        manualReconciliationRequired: false,
        observedAt: "2026-07-23T10:00:00.000Z",
      },
    ]);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-a" onValue={onValue} />);
    });
    const previous = onValue.mock.lastCall![0];
    expect(previous.inspection?.workspaceId).toBe("workspace-a");
    expect(previous.invocationActivity).toHaveLength(1);

    let finishPrevious!: (value: ReturnType<typeof inspection>) => void;
    let finishCurrent!: (value: ReturnType<typeof inspection>) => void;
    apiMocks.fetchMeshCapabilityPublications
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPrevious = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCurrent = resolve;
          }),
      );
    await act(async () => {
      void previous.reload();
    });

    onValue.mockClear();
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-b" onValue={onValue} />);
    });
    expect(onValue.mock.calls[0]?.[0]).toMatchObject({
      inspection: null,
      invocationActivity: [],
      activityError: null,
      loading: true,
      error: null,
    });

    await act(async () => {
      finishPrevious(inspection("workspace-a"));
      await previous.reload();
    });
    expect(apiMocks.fetchMeshCapabilityPublications.mock.calls).toEqual([
      ["workspace-a"],
      ["workspace-a"],
      ["workspace-b"],
    ]);
    expect(onValue.mock.lastCall?.[0]).toMatchObject({ inspection: null, loading: true });

    await act(async () => {
      finishCurrent(inspection("workspace-b"));
    });
    expect(onValue.mock.lastCall?.[0]).toMatchObject({
      inspection: { workspaceId: "workspace-b" },
      loading: false,
    });
    await act(async () => renderer.unmount());
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
