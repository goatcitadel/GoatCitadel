import { describe, expect, it } from "vitest";
import { classifySurfaceHeuristic } from "./surface-router-heuristics.js";

describe("classifySurfaceHeuristic", () => {
  it("routes explicit coding intent to chat with high confidence", () => {
    const result = classifySurfaceHeuristic("run tests in the repo and fix the failing pytest", {
      hasBoundProject: true,
    });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.alternatives).toEqual([]);
  });

  it("routes research/multi-step intent to chat", () => {
    const result = classifySurfaceHeuristic("research the top 5 vector databases and compare tradeoffs", {
      hasBoundProject: false,
    });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("defaults a plain greeting to high-confidence chat", () => {
    const result = classifySurfaceHeuristic("hey, how are you?", { hasBoundProject: false });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBe(1);
  });

  it("treats an empty prompt as low-confidence chat", () => {
    const result = classifySurfaceHeuristic("   ", { hasBoundProject: false });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBeLessThan(0.5);
  });
});
