import { describe, expect, it } from "vitest";
import type {
  AgenticDiagnosticCode,
  AgenticScalabilityTrackRecord,
  AgenticSubagentMetadata,
} from "./agentic-runtime.js";

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

describe("AgenticScalabilityTrackRecord", () => {
  it("models protocol availability separately from provider availability", () => {
    const track: AgenticScalabilityTrackRecord = {
      trackId: "a2a_protocol",
      label: "A2A protocol interoperability",
      kind: "agent_protocol",
      status: "unavailable",
      callable: false,
      implementationStatus: "missing",
      summary: "A2A is not implemented as a protocol surface.",
      reasons: ["No Agent Card route is registered."],
      evidence: [{ label: "A2A specification", url: "https://a2aproject.github.io/A2A/latest/specification/" }],
      requiredNextSteps: ["Add gateway-owned A2A server and client services"],
      checkedAt: "2026-05-30T00:00:00.000Z",
    };

    expect(track.kind).toBe("agent_protocol");
    expect(track.callable).toBe(false);
  });
});
