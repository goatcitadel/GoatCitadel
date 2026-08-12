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

  it("omits delegated scope host paths from nested approval evidence without mutating canonical truth", () => {
    const rootPath = "F:\\private\\workspace";
    const canonical = {
      approvals: {
        items: [
          {
            approvalId: "approval-scope-expansion",
            kind: "delegation_scope_expansion",
            payload: {
              schemaVersion: "delegation.scope-expansion.v1",
              rootPath,
              requestedPaths: ["docs"],
              resolvedPaths: [`${rootPath}\\docs`],
              scopeHash: "a".repeat(64),
            },
          },
        ],
      },
    };

    const projected = projectDurableRouteResponse(canonical);

    expect(projected.approvals.items[0]?.payload).toEqual({
      schemaVersion: "delegation.scope-expansion.v1",
      requestedPaths: ["docs"],
      scopeHash: "a".repeat(64),
    });
    expect(JSON.stringify(projected)).not.toContain(rootPath);
    expect(canonical.approvals.items[0]?.payload).toMatchObject({
      rootPath,
      resolvedPaths: [`${rootPath}\\docs`],
    });
  });
});
