import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAuthorityProjectionResponse } from "@goatcitadel/contracts";
import { useRuntimeAuthorityProjection } from "./useRuntimeAuthorityProjection";

const apiMocks = vi.hoisted(() => ({ fetchRuntimeAuthorityProjection: vi.fn() }));

vi.mock("../api/runtime-authority", () => ({
  fetchRuntimeAuthorityProjection: apiMocks.fetchRuntimeAuthorityProjection,
}));
vi.mock("./useRefreshSubscription", () => ({ useRefreshSubscription: vi.fn() }));

type HookValue = ReturnType<typeof useRuntimeAuthorityProjection>;

function Harness({ workspaceId, onValue }: { workspaceId: string; onValue: (value: HookValue) => void }) {
  onValue(useRuntimeAuthorityProjection(workspaceId));
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRuntimeAuthorityProjection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the prior workspace envelope and hides upstream error details when scoped loading fails", async () => {
    apiMocks.fetchRuntimeAuthorityProjection.mockResolvedValueOnce(projection("workspace-a"));
    let latest: HookValue | undefined;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-a" onValue={(value) => (latest = value)} />);
    });
    await flush();
    expect(latest?.data?.workspaceId).toBe("workspace-a");

    apiMocks.fetchRuntimeAuthorityProjection.mockRejectedValueOnce(
      new Error("C:\\private\\runtime\\config.json contained sk-secret-value"),
    );
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-b" onValue={(value) => (latest = value)} />);
    });
    expect(latest?.data).toBeNull();
    await flush();
    expect(latest?.data).toBeNull();
    expect(latest?.error).toBe("The scoped runtime authority envelope is unavailable.");
    expect(latest?.error).not.toMatch(/private|secret|config\.json/i);
    renderer!.unmount();
  });
});

function projection(workspaceId: string): RuntimeAuthorityProjectionResponse {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-13T20:00:00.000Z",
    workspaceId,
    items: [],
  };
}
