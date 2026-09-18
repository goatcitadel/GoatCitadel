import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { probeLiveCapabilityDispositions } from "./usability-capability-dispositions.mjs";

function fixture({ revision = "a".repeat(64), archiveStatus = 200 } = {}) {
  const calls = [];
  const item = { capabilityId: "tool:time.now", kind: "tool", toolName: "time.now",
    wrapperVisibility: { readOnly: true, deterministic: true, codeModeAllowed: true },
    effectPotential: { version: "v1", potential: "none", sourceKind: "builtin", reason: "clock" } };
  const input = { baseSha: "b".repeat(40), gatewayUrl: "http://fixture.invalid", sessionId: "fixture-session",
    workspaceId: "default", workspaceRoot: path.resolve("fixture/workspace"), evidenceRef: "fixture.json",
    capabilityCatalog: { inspectable: [item], callable: [item] },
    requestJson: async (_base, route, options) => {
      calls.push({ route, options });
      if (route === "/api/v1/files/upload") return { ok: true, status: 200, body: {
        relativePath: options.body.relativePath, bytes: options.body.content.length,
        fullPath: path.join(input.workspaceRoot, options.body.relativePath),
      } };
      if (route === "/api/v1/tools/permission-profiles") return { ok: true, status: 200, body: { profileId: "fixture-profile", revision } };
      if (route === "/api/v1/tools/invoke") {
        const epochMs = Date.now();
        return { ok: true, status: 200, body: { outcome: "executed", result: {
          epochMs, iso: new Date(epochMs).toISOString(), local: "fixture local time", timezone: "UTC",
        } } };
      }
      if (route === "/api/v1/tools/permission-profiles/fixture-profile/archive") {
        assert.deepEqual(options.body, { expectedRevision: revision });
        return { ok: archiveStatus === 200, status: archiveStatus, body: archiveStatus === 200 ? { archived: true } : { error: "stale revision" } };
      }
      throw new Error(`Unexpected request ${route}`);
    },
  };
  return { calls, input };
}

test("capability probe archives only the profile revision returned by creation", async () => {
  const { calls, input } = fixture();
  const rows = await probeLiveCapabilityDispositions(input);
  assert.equal(rows[0].status, "passed");
  assert.equal(calls.filter(call => call.route.endsWith("/archive")).length, 1);
});

test("capability probe rejects absent or malformed review revisions before invoking tools", async () => {
  for (const revision of [null, "", "short", "z".repeat(64)]) {
    const { calls, input } = fixture({ revision });
    await assert.rejects(probeLiveCapabilityDispositions(input), /revision/u);
    assert.equal(calls.some(call => call.route === "/api/v1/tools/invoke"), false);
    assert.equal(calls.some(call => call.route.endsWith("/archive")), false);
  }
});

test("capability probe reports stale cleanup without fetching a new revision or retrying", async () => {
  const { calls, input } = fixture({ archiveStatus: 409 });
  await assert.rejects(probeLiveCapabilityDispositions(input), /stale revision/u);
  assert.equal(calls.filter(call => call.route.endsWith("/archive")).length, 1);
  assert.ok(calls.every(call => call.options.method === "POST"));
});
