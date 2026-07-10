import { describe, expect, it, vi } from "vitest";
import { RuntimeLifecycleRouteService } from "./runtime-lifecycle-route-service.js";

describe("RuntimeLifecycleRouteService", () => {
  it("adds canonical lifecycle and export links to route projections and bundles", async () => {
    const getRuntimeLifecycle = vi.fn(async () => ({
      query: { sessionId: "session-1" },
      canonical: { runId: "run-1", sessionId: "session-1" },
      linked: {
        sessionIds: ["session-1"],
        turnIds: [],
        runIds: ["run-1"],
        proactiveRunIds: [],
        approvalIds: [],
        taskIds: [],
        workspaceIds: [],
      },
      turns: [],
      toolRuns: [
        {
          toolRunId: "tool-1",
          args: {
            webhookUrl: "https://hooks.example.test/send?token=short-token",
            tokenEnv: "WEBHOOK_TOKEN",
          },
          result: {
            authorization: "Bearer short",
            DATABASE_PASSWORD: "tiny-secret",
            tokenBudget: 2048,
          },
        },
      ],
      approval: {
        approvalId: "approval-1",
        status: "pending",
        payload: {
          authorization: "Bearer short",
          secretRef: "vault:approval-1",
          tokenId: "remote-token-id-1",
        },
      },
    }));
    const service = new RuntimeLifecycleRouteService({
      getRuntimeLifecycle,
      getTranscript: vi.fn(async () => []),
      listSessionTimeline: vi.fn(async () => []),
    });

    const lifecycle = await service.getLifecycle({ sessionId: "session-1" });
    const bundle = await service.exportLifecycle({ sessionId: "session-1", format: "bundle" });

    expect(lifecycle.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rel: "export_siem_ndjson",
          href: "/api/v1/runtime/lifecycle/export?runId=run-1&includeTimeline=true&format=siem_ndjson",
          contentType: "application/x-ndjson",
          format: "siem_ndjson",
        }),
        expect.objectContaining({
          rel: "export_trust_report",
          href: "/api/v1/runtime/lifecycle/export?runId=run-1&includeTranscript=true&includeTimeline=true&format=trust_report",
        }),
      ]),
    );
    expect(bundle.links).toEqual(lifecycle.links);
    for (const projection of [lifecycle, bundle]) {
      expect(JSON.stringify(projection)).not.toContain("short-token");
      expect(JSON.stringify(projection)).not.toContain("Bearer short");
      expect(JSON.stringify(projection)).not.toContain("tiny-secret");
      expect(projection).toMatchObject({
        toolRuns: [{ args: { tokenEnv: "WEBHOOK_TOKEN" }, result: { tokenBudget: 2048 } }],
        approval: {
          payload: { secretRef: "vault:approval-1", tokenId: "remote-token-id-1" },
        },
      });
    }
  });
});
