import { describe, expect, it } from "vitest";
import { classifySurfaceHeuristic } from "./surface-router-heuristics.js";

describe("classifySurfaceHeuristic", () => {
  it("routes explicit coding intent to code with high confidence", () => {
    const result = classifySurfaceHeuristic("run tests in the repo and fix the failing pytest", {
      hasBoundProject: true,
    });
    expect(result.mode).toBe("code");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.alternatives).not.toContain("code");
  });

  it("routes research/multi-step intent to cowork", () => {
    const result = classifySurfaceHeuristic("research the top 5 vector databases and compare tradeoffs", {
      hasBoundProject: false,
    });
    expect(result.mode).toBe("cowork");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("defaults a plain greeting to chat with low confidence", () => {
    const result = classifySurfaceHeuristic("hey, how are you?", { hasBoundProject: false });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("treats an empty prompt as low-confidence chat", () => {
    const result = classifySurfaceHeuristic("   ", { hasBoundProject: false });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBeLessThan(0.5);
  });
});
