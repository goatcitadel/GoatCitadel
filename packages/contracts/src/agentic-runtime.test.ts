import { describe, expect, it } from "vitest";
import type {
  AgenticDiagnosticCode,
  AgenticRunStatus,
  AgenticScalabilityTrackRecord,
  AgenticSubagentMetadata,
} from "./agentic-runtime.js";

describe("AgenticDiagnosticCode", () => {
  it("includes runtime budget, projection reconciliation, and Cowork research codes", () => {
    const codes: AgenticDiagnosticCode[] = [
      "max_depth_exceeded",
      "timeout_exceeded",
      "projection_status_drift",
      "durable_missing_after_completion",
      "research_evidence_incomplete",
      "candidate_discovery_incomplete",
      "source_access_blocked",
    ];
    expect(codes).toHaveLength(7);
  });
});

describe("AgenticRunStatus", () => {
  it("models canonical Cowork checkpoint and blocked states while retaining legacy stop-limit reads", () => {
    const statuses: AgenticRunStatus[] = ["checkpointing", "blocked", "stopped_by_limit"];
    expect(statuses).toEqual(["checkpointing", "blocked", "stopped_by_limit"]);
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
      status: "blocked",
      callable: false,
      implementationStatus: "partial",
      summary: "A2A is present as a Gateway-owned external interoperability boundary but is not currently callable.",
      reasons: ["Callable JSON-RPC requires configured peer credentials and Gateway-owned durable task bindings."],
      evidence: [{ label: "A2A specification", url: "https://a2a-protocol.org/latest/specification/" }],
      requiredNextSteps: ["Keep broader A2A transports non-callable until implemented and tested"],
      checkedAt: "2026-05-30T00:00:00.000Z",
    };

    expect(track.kind).toBe("agent_protocol");
    expect(track.callable).toBe(false);
  });
});
