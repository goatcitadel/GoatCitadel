import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRuntimeAuthorityProjection } from "./runtime-authority";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({ request: apiMocks.request }));

beforeEach(() => {
  apiMocks.request.mockReset();
  apiMocks.request.mockResolvedValue({
    schemaVersion: 1,
    generatedAt: "2026-07-13T20:00:00.000Z",
    workspaceId: "workspace-one",
    items: [],
  });
});

describe("runtime authority api", () => {
  it("encodes only the workspace selector and never accepts client authority metadata", async () => {
    await fetchRuntimeAuthorityProjection("workspace-one");
    expect(apiMocks.request).toHaveBeenCalledWith("/api/v1/ops/runtime-authority?workspaceId=workspace-one");
  });

  it.each(["", "workspace/one", "workspace one", "x".repeat(81)])(
    "rejects invalid or absent workspace scope %j before issuing a request",
    async (workspaceId) => {
      await expect(fetchRuntimeAuthorityProjection(workspaceId)).rejects.toThrow(/valid workspace scope/i);
      expect(apiMocks.request).not.toHaveBeenCalled();
    },
  );

  it("rejects foreign workspace envelopes and untyped deep links instead of exposing them to the UI", async () => {
    apiMocks.request.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: "2026-07-13T20:00:00.000Z",
      workspaceId: "workspace-foreign",
      items: [],
    });
    await expect(fetchRuntimeAuthorityProjection("workspace-one")).rejects.toThrow(
      /invalid runtime authority envelope/i,
    );

    apiMocks.request.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: "2026-07-13T20:00:00.000Z",
      workspaceId: "workspace-one",
      items: [
        {
          id: "run-1",
          domain: "runs",
          label: "Run",
          authorityClass: "canonical_record",
          owner: "DurableRunRepository",
          source: "durable run rows",
          freshness: "current",
          posture: "ok",
          state: "Completed.",
          basis: "Owner row.",
          scope: { kind: "workspace", workspaceId: "workspace-one" },
          canonicalRef: { kind: "raw_href", href: "/invented" },
        },
      ],
    });
    await expect(fetchRuntimeAuthorityProjection("workspace-one")).rejects.toThrow(
      /invalid runtime authority envelope/i,
    );
  });
});
