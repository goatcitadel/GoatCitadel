import { describe, expect, it } from "vitest";
import { projectDurableRouteResponse } from "./durable-public-projection.js";

describe("projectDurableRouteResponse", () => {
  it("recursively omits raw heartbeat output from nested objects and arrays without mutating canonical evidence", () => {
    const canonical = {
      runId: "run-heartbeat",
      metadata: {
        heartbeatDecisionReceipt: { version: 1, notify: false },
        heartbeatDecisionRawOutput: '{"notify":false}',
        nested: [
          {
            heartbeatDecisionRawOutput: '{"notify":true,"message":"private"}',
            retained: true,
          },
        ],
      },
      checkpoints: [
        {
          state: {
            heartbeatDecisionRawOutput: '{"notify":false}',
            heartbeatDecisionReceipt: { version: 1, notify: false },
          },
        },
      ],
      unrelated: { rawOutput: "public-shape-is-unchanged" },
    };

    const projected = projectDurableRouteResponse(canonical);

    expect(JSON.stringify(projected)).not.toContain("heartbeatDecisionRawOutput");
    expect(projected).toMatchObject({
      metadata: {
        heartbeatDecisionReceipt: { version: 1, notify: false },
        nested: [{ retained: true }],
      },
      checkpoints: [{ state: { heartbeatDecisionReceipt: { version: 1, notify: false } } }],
      unrelated: { rawOutput: "public-shape-is-unchanged" },
    });
    expect(canonical.metadata.heartbeatDecisionRawOutput).toBe('{"notify":false}');
    expect(canonical.metadata.nested[0]?.heartbeatDecisionRawOutput).toContain("private");
    expect(canonical.checkpoints[0]?.state.heartbeatDecisionRawOutput).toBe('{"notify":false}');
  });
});
