import assert from "node:assert/strict";
import test from "node:test";
import { classicUiParityProbe } from "./ui-parity-owner-contract.mjs";

test("all existing parity probes explicitly visit their Classic rollback owner", () => {
  const probes = [
    ["/ops/approvals", "ops", "approvals", "Approval queue"],
    ["/ops/runtime", "ops", "runtime", "Services"],
    ["/ops/diagnostics", "ops", "diagnostics", "Diagnostics directory"],
    ["/ops/activity", "ops", "activity", "Activity feed"],
    ["/library/memory", "library", "memory", "Memory items"],
    ["/settings/mcp", "settings", "mcp", "MCP servers"],
  ];
  for (const [href, expectedArea, expectedSection, readyText] of probes) {
    const input = { expectedArea, expectedSection, readyText };
    const proof = classicUiParityProbe(href, input);
    const url = new URL(proof.href, "http://127.0.0.1");
    assert.equal(url.pathname, href); assert.equal(url.searchParams.get("shell"), "classic");
    assert.equal(url.searchParams.get("shellScope"), "visit");
    assert.deepEqual(proof.route, { ...input, shell: "classic" });
    assert.equal(input.shell, undefined);
  }
});

test("temporary owner selection preserves seeded context and the readiness contract", () => {
  const probe = classicUiParityProbe("/ops/approvals?approvalId=fixture-approval&workspaceId=fixture-workspace&shell=cockpit#queue",
    { expectedArea: "ops", expectedSection: "approvals", readyText: "Approval queue", readySelector: ".fixture-ready", shell: "cockpit" });
  const url = new URL(probe.href, "http://127.0.0.1");
  assert.equal(url.searchParams.get("approvalId"), "fixture-approval");
  assert.equal(url.searchParams.get("workspaceId"), "fixture-workspace"); assert.equal(url.hash, "#queue");
  assert.deepEqual(url.searchParams.getAll("shell"), ["classic"]);
  assert.deepEqual(url.searchParams.getAll("shellScope"), ["visit"]);
  assert.equal(probe.route.readySelector, ".fixture-ready"); assert.equal(probe.route.readyText, "Approval queue");
  assert.equal(probe.route.shell, "classic");
});
