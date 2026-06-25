import { beforeEach, describe, expect, it, vi } from "vitest";

import * as capabilitiesScope from "./capabilities-scope";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
}));

beforeEach(() => {
  apiMocks.request.mockReset();
  apiMocks.request.mockResolvedValue({});
});

function lastCall(): [string, RequestInit | undefined] {
  const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
  return [path as string, init as RequestInit | undefined];
}

function body(init: RequestInit | undefined): unknown {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

describe("capability-scope API client", () => {
  describe("citadel endpoints", () => {
    it("fetchCitadelCapabilities calls GET with the correct URL", async () => {
      await capabilitiesScope.fetchCitadelCapabilities("personal", "skill");
      const [url, init] = lastCall();
      expect(url).toBe("/api/v1/citadels/personal/capabilities?type=skill");
      expect(init).toBeUndefined();
    });

    it("fetchCitadelCapabilities encodes citadelId with path separators", async () => {
      await capabilitiesScope.fetchCitadelCapabilities("a/b", "mcp_server");
      expect(lastCall()[0]).toBe("/api/v1/citadels/a%2Fb/capabilities?type=mcp_server");
    });

    it("updateCitadelCapabilities calls PATCH with body", async () => {
      const input = {
        resourceType: "skill" as const,
        assignments: [{ resourceRef: "skill-a", enabled: true }],
      };
      await capabilitiesScope.updateCitadelCapabilities("personal", input);
      const [url, init] = lastCall();
      expect(url).toBe("/api/v1/citadels/personal/capabilities");
      expect(init?.method).toBe("PATCH");
      expect(body(init)).toEqual(input);
    });

    it("resetCitadelCapabilities calls DELETE with type query param", async () => {
      await capabilitiesScope.resetCitadelCapabilities("personal", "integration");
      const [url, init] = lastCall();
      expect(url).toBe("/api/v1/citadels/personal/capabilities?type=integration");
      expect(init?.method).toBe("DELETE");
    });
  });

  describe("workspace endpoints", () => {
    it("fetchWorkspaceCapabilities calls GET with the correct URL", async () => {
      await capabilitiesScope.fetchWorkspaceCapabilities("default", "mcp_server");
      const [url, init] = lastCall();
      expect(url).toBe("/api/v1/workspaces/default/capabilities?type=mcp_server");
      expect(init).toBeUndefined();
    });

    it("fetchWorkspaceCapabilities encodes workspaceId with path separators", async () => {
      await capabilitiesScope.fetchWorkspaceCapabilities("a/b", "skill");
      expect(lastCall()[0]).toBe("/api/v1/workspaces/a%2Fb/capabilities?type=skill");
    });

    it("updateWorkspaceCapabilities calls PATCH with body", async () => {
      const input = {
        resourceType: "mcp_server" as const,
        assignments: [{ resourceRef: "mcp-1", enabled: false }],
      };
      await capabilitiesScope.updateWorkspaceCapabilities("default", input);
      const [url, init] = lastCall();
      expect(url).toBe("/api/v1/workspaces/default/capabilities");
      expect(init?.method).toBe("PATCH");
      expect(body(init)).toEqual(input);
    });

    it("resetWorkspaceCapabilities calls DELETE with type query param", async () => {
      await capabilitiesScope.resetWorkspaceCapabilities("default", "skill");
      const [url, init] = lastCall();
      expect(url).toBe("/api/v1/workspaces/default/capabilities?type=skill");
      expect(init?.method).toBe("DELETE");
    });
  });
});
