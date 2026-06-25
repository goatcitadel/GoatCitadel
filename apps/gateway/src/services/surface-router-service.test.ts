import { describe, expect, it, vi } from "vitest";
import { SurfaceRouterService } from "./surface-router-service.js";

describe("SurfaceRouterService", () => {
  it("classifies and appends a routing_choice trace with scope", () => {
    const append = vi.fn();
    const service = new SurfaceRouterService({
      classify: () => ({
        mode: "code",
        confidence: 0.85,
        source: "heuristic",
        rationale: "explicit code/test intent",
        alternatives: ["cowork", "chat"],
      }),
      traceRepo: { append } as never,
    });

    const result = service.route({
      prompt: "run tests in the repo",
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      context: { hasBoundProject: true },
    });

    expect(result.mode).toBe("code");
    expect(append).toHaveBeenCalledTimes(1);
    const traceArg = append.mock.calls[0][0];
    expect(traceArg.kind).toBe("routing_choice");
    expect(traceArg.selected).toBe("code");
    expect(traceArg.scope).toMatchObject({ citadelId: "personal", workspaceId: "default", sessionId: "s1", turnId: "t1" });
  });
});
