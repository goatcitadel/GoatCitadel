import { describe, expect, it, vi } from "vitest";
import { SurfaceRouterService } from "./surface-router-service.js";

describe("SurfaceRouterService", () => {
  it("classifies and appends a routing_choice trace with scope", async () => {
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

    const result = await service.route({
      prompt: "run tests in the repo",
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      context: { hasBoundProject: true },
    });

    expect(result.mode).toBe("chat");
    expect(append).toHaveBeenCalledTimes(1);
    const traceArg = append.mock.calls[0][0];
    expect(traceArg.kind).toBe("routing_choice");
    expect(traceArg.selected).toBe("chat");
    expect(traceArg.scope).toMatchObject({
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
    });
  });

  it("falls back to the judge when heuristic confidence is below threshold", async () => {
    const append = vi.fn();
    const judge = vi.fn(async () => ({ mode: "code" as const, confidence: 0.9 }));
    const service = new SurfaceRouterService({
      classify: () => ({
        mode: "chat",
        confidence: 0.3,
        source: "heuristic",
        rationale: "x",
        alternatives: ["cowork", "code"],
      }),
      judge,
      fetchExemplars: () => [],
      traceRepo: { append } as never,
    });

    const result = await service.route({
      prompt: "something ambiguous",
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      context: { hasBoundProject: false },
    });

    expect(result.mode).toBe("chat");
    expect(judge).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    const traceArg = append.mock.calls[0][0];
    expect(traceArg.selected).toBe("chat");
  });

  it("does not call the judge when heuristic confidence is at or above threshold", async () => {
    const append = vi.fn();
    const judge = vi.fn();
    const service = new SurfaceRouterService({
      classify: () => ({
        mode: "code",
        confidence: 0.85,
        source: "heuristic",
        rationale: "explicit code/test intent",
        alternatives: ["cowork", "chat"],
      }),
      judge,
      fetchExemplars: () => [],
      traceRepo: { append } as never,
    });

    const result = await service.route({
      prompt: "fix the repo",
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      context: { hasBoundProject: true },
    });

    expect(result.mode).toBe("chat");
    expect(result.source).toBe("heuristic");
    expect(judge).not.toHaveBeenCalled();
  });
});
