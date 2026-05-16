import { describe, expect, it } from "vitest";
import type { AgenticDiagnosticCode, AgenticSubagentMetadata } from "./agentic-runtime.js";

describe("AgenticDiagnosticCode", () => {
  it("includes max_depth_exceeded and timeout_exceeded", () => {
    const codes: AgenticDiagnosticCode[] = ["max_depth_exceeded", "timeout_exceeded"];
    expect(codes).toHaveLength(2);
  });
});

describe("AgenticSubagentMetadata", () => {
  it("accepts a depth integer", () => {
    const md: AgenticSubagentMetadata = { depth: 2 };
    expect(md.depth).toBe(2);
  });
});
