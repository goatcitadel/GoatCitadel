import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exerciseProvider,
  fetchDevStatus,
  fetchRouteManifest,
  seedChatApprovalScenario,
  seedChatUserInputScenario,
  seedDurableRecovery,
  seedMemoryItem,
  seedWorkspace,
} from "./dev-verification";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: requestMock }));

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({});
});

function lastPost() {
  const [path, init] = requestMock.mock.calls.at(-1) ?? [];
  return {
    path,
    method: (init as RequestInit | undefined)?.method,
    body: JSON.parse(String((init as RequestInit).body)),
  };
}

describe("dev verification client", () => {
  it("reads status and the route list", async () => {
    await fetchDevStatus();
    await fetchRouteManifest();
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/dev/verification/status",
      "/api/v1/dev/verification/route-access-manifest",
    ]);
  });

  it("seeds a one-session workspace", async () => {
    await seedWorkspace("Test bench run");
    expect(lastPost()).toEqual({
      path: "/api/v1/dev/verification/seed",
      method: "POST",
      body: {
        workspaceName: "Test bench run",
        sessionTitle: "Test bench run session",
        sessionCount: 1,
        longThreadTurns: 2,
      },
    });
  });

  it("posts each scenario seed to its route", async () => {
    const scope = { sessionId: "s-1", workspaceId: "ws-1" };
    await seedChatApprovalScenario(scope);
    expect(lastPost()).toMatchObject({ path: "/api/v1/dev/verification/chat-approval-scenario", body: scope });
    await seedChatUserInputScenario(scope);
    expect(lastPost()).toMatchObject({ path: "/api/v1/dev/verification/chat-user-input-scenario", body: scope });
    await seedMemoryItem({ workspaceId: "ws-1", namespace: "testbench", title: "Note", content: "Body" });
    expect(lastPost()).toMatchObject({
      path: "/api/v1/dev/verification/memory-item-seed",
      body: { namespace: "testbench" },
    });
    await exerciseProvider({ scenario: "simple" });
    expect(lastPost()).toMatchObject({
      path: "/api/v1/dev/verification/provider-exercise",
      body: { scenario: "simple" },
    });
  });

  it("forwards an abort signal to the request for reads and seeds", async () => {
    const { signal } = new AbortController();
    await fetchDevStatus(signal);
    expect(requestMock).toHaveBeenLastCalledWith("/api/v1/dev/verification/status", { signal });
    await seedWorkspace("Test bench run", signal);
    expect(requestMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST", signal });
    await seedDurableRecovery(signal);
    expect(requestMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST", signal });
  });

  it("sends an empty JSON object to the body-less durable recovery seed", async () => {
    await seedDurableRecovery();
    expect(lastPost()).toEqual({ path: "/api/v1/dev/verification/durable-recovery-seed", method: "POST", body: {} });
  });
});
