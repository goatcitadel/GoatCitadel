import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Skill Hub operator API", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", pathname: "/library/skills", search: "", hash: "" },
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => "skill-hub-request" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the workspace-scoped operator projection with a bounded limit", async () => {
    const response = {
      schemaVersion: "goatcitadel.skill-hub-operator.v1",
      workspaceId: "workspace/one",
      generatedAt: "2026-07-14T00:00:00.000Z",
      summary: {
        snapshots: 0,
        retainedCandidates: 0,
        inactive: 0,
        callable: 0,
        blocked: 0,
        pendingApprovals: 0,
      },
      page: { limit: 100, returned: 0, truncated: false, candidateInventoryTruncated: false },
      items: [],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchSkillHubOperator } = await import("./skill-hub.js");

    expect(await fetchSkillHubOperator({ workspaceId: "workspace/one", limit: 500 })).toEqual(response);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v1/skills/hub");
    expect(url.searchParams.get("workspaceId")).toBe("workspace/one");
    expect(url.searchParams.get("limit")).toBe("100");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).cache).toBe("no-store");
  });

  it("creates only an approval request for the selected immutable version", async () => {
    const response = {
      schemaVersion: "goatcitadel.skill-hub-operator.v1",
      reused: false,
      operatorMessage: "Approval created.",
      approval: {
        approvalId: "approval-1",
        operationId: "operation-1",
        operationKind: "stage_update_candidate",
        status: "pending",
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createSkillHubOperatorApproval } = await import("./skill-hub.js");

    expect(
      await createSkillHubOperatorApproval({
        workspaceId: "workspace-1",
        snapshotId: "snapshot-1",
        operationKind: "stage_update_candidate",
        sessionId: "session-1",
      }),
    ).toEqual(response);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: "workspace-1",
      snapshotId: "snapshot-1",
      operationKind: "stage_update_candidate",
      sessionId: "session-1",
    });
    expect(init.cache).toBe("no-store");
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
