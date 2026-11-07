import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectDeviceOwnerEvidence, runCockpitDeviceAccessProof } from "./cockpit-device-access-proof.mjs";
import { createOwnerReadDiagnostic } from "./cockpit-approval-mode-proof.mjs";

it("projects actual owner order and current-grant relationships without retaining labels, tokens or responses", () => {
  const items = Array.from({ length: 25 }, (_, index) => ({ grantId: `grant-${index}`, deviceLabel: "private-poll-secret-canary", token: "private-poll-secret-canary" }));
  const probe = createOwnerReadDiagnostic();
  probe.device(projectDeviceOwnerEvidence({ items, privatePollSecret: "private-poll-secret-canary" }, "grant-23", "grant-1", { observed: true, grantId: "grant-23" }));
  const evidence = probe.snapshot().device;
  assert.deepEqual(evidence, { total: 25, subjectIndex: 23, peerIndex: 1, currentGrantPresent: true, subjectIsCurrent: true, peerIsCurrent: false });
  assert.ok(!JSON.stringify(evidence).includes("private-poll-secret-canary"));
  assert.equal(projectDeviceOwnerEvidence({ items }, "missing", "grant-1").subjectIndex, -1);
  assert.equal(projectDeviceOwnerEvidence({ items }, "missing", "grant-1").subjectIsCurrent, null);
  assert.equal(projectDeviceOwnerEvidence(null, "missing", "grant-1").total, null);
});

it("keeps the original failed journey when UI capture, screenshot and diagnostic writing all fail", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "goatcitadel-owner-diagnostic-"));
  try {
    const blocker = path.join(directory, "blocked-artifacts");
    await writeFile(blocker, "task-owned writer failure fixture");
    const original = new Error("Original subject row unavailable.");
    const row = { waitFor: async () => { throw original; } };
    const panel = { getByRole: () => ({ filter: () => row }) };
    const page = { on() {}, goto: async () => {}, getByRole: () => panel, isClosed: () => false,
      evaluate: async () => { throw new Error("private-poll-secret-canary"); },
      screenshot: async () => { throw new Error("private-poll-secret-canary"); } };
    const grants = []; let requestCount = 0, result;
    const requestJson = async (_url, route, init) => {
      if (route === "/api/v1/auth/device-requests") {
        requestCount++;
        grants.push({ grantId: `grant-${requestCount}`, requestId: `request-${requestCount}`, deviceLabel: init.body.deviceLabel });
        return { ok: true, status: 200, body: { approvalId: `approval-${requestCount}`, requestId: `request-${requestCount}`, pollSecret: "private-poll-secret-canary" } };
      }
      if (route.startsWith("/api/v1/approvals/")) return { ok: true, status: 200, body: { approval: { approvalId: `approval-${requestCount}`, status: "approved" } } };
      return { ok: true, status: 200, body: { items: grants } };
    };
    await runCockpitDeviceAccessProof({ context: { artifactRoot: blocker }, stack: { runtimeRoot: directory, gatewayUrl: "unused" }, citadelId: "personal",
      browser: { newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page, close: async () => {} }) },
      viewports: [{ variant: "mobile", viewport: { width: 390, height: 844 } }],
      deps: { path, requestJson, buildVerificationUiUrl: (_url, route) => route, installMissionControlNextBrowserState: async () => {},
        relativeToRun: (_context, value) => value, emptyArtifacts: value => value,
        runScenario: async (_context, _definition, run) => { result = await run(); } },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error, original.stack);
    assert.equal(result.metrics.diagnosticWriteFailure, true);
    assert.deepEqual(result.artifacts.diagnostics, []);
    assert.ok(!JSON.stringify(result).includes("private-poll-secret-canary"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
