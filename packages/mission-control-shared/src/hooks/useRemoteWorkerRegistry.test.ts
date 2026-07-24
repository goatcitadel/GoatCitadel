import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerRegistryPage } from "@goatcitadel/contracts";
import { useRemoteWorkerRegistry, type RemoteWorkerRegistryState } from "./useRemoteWorkerRegistry";

const apiMocks = vi.hoisted(() => ({ fetchRemoteWorkerRegistry: vi.fn() }));
vi.mock("../api/remote-workers.js", () => ({ fetchRemoteWorkerRegistry: apiMocks.fetchRemoteWorkerRegistry }));
// The refresh subscription is exercised in its own suite; stub it so the hook
// unit test does not stand up refresh-bus timers.
vi.mock("./useRefreshSubscription.js", () => ({ useRefreshSubscription: vi.fn() }));

function Harness({
  workspaceId,
  onValue,
}: {
  workspaceId: string;
  onValue: (value: RemoteWorkerRegistryState) => void;
}) {
  const value = useRemoteWorkerRegistry(workspaceId);
  onValue(value);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function page(): RemoteWorkerRegistryPage {
  return {
    schemaVersion: "goatcitadel.remote-worker-registry-page.v1",
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "workspace-a",
    items: [],
    observedAt: "2026-07-15T12:00:00.000Z",
  } as RemoteWorkerRegistryPage;
}

describe("useRemoteWorkerRegistry", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: RemoteWorkerRegistryState | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("loads the canonical registry page for the workspace", async () => {
    apiMocks.fetchRemoteWorkerRegistry.mockResolvedValue(page());
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          workspaceId: "workspace-a",
          onValue: (value) => {
            latest = value;
          },
        }),
      );
    });
    await flush();
    expect(apiMocks.fetchRemoteWorkerRegistry).toHaveBeenCalledWith("workspace-a", {});
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.page?.workspaceId).toBe("workspace-a");
  });

  it("surfaces an unavailable registry instead of inventing worker facts", async () => {
    apiMocks.fetchRemoteWorkerRegistry.mockRejectedValue(new Error("gateway down"));
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          workspaceId: "workspace-a",
          onValue: (value) => {
            latest = value;
          },
        }),
      );
    });
    await flush();
    expect(latest?.loading).toBe(false);
    expect(latest?.page).toBeNull();
    expect(latest?.error).toMatch(/unavailable/u);
  });
});
