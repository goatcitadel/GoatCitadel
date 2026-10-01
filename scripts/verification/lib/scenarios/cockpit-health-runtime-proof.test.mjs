import assert from "node:assert/strict";
import test from "node:test";
import { assertHealthNativeNavigation, HEALTH_LOCAL_AI_HREF } from "./cockpit-health-runtime-proof.mjs";

function proof() {
  const settings = { revision: 7, llamaCpp: {
    enabled: false, autoStart: false, managementMode: "managed", baseUrl: "http://127.0.0.1:8080/v1",
    command: "llama-server", extraArgs: [], modelsRootPath: "fixture/models", modelPath: "", alias: "fixture-model",
    ctxSize: 4096, threads: 4, gpuLayers: 0, parallel: 1, batchSize: 1024, ubatchSize: 512, flashAttention: false,
    status: { enabled: false, desiredState: "stopped", processState: "stopped", healthy: false,
      baseUrl: "http://127.0.0.1:8080/v1", updatedAt: "2026-10-01T00:00:00.000Z",
      leaseDiagnostics: { state: "idle", activeLeaseCount: 0, ownership: "none", purposes: [],
        persistentDemand: { manual: false, api: false, autostart: false },
        evidence: { lastProbe: { at: "2026-10-01T00:00:00.000Z", healthy: false } } } },
  } };
  return {
    uiUrl: "http://127.0.0.1:1234", url: "http://127.0.0.1:1234/settings/models?shell=cockpit#local-ai",
    documentRequestsBefore: 1, documentRequestsAfter: 1, marker: "same-document", expectedMarker: "same-document",
    selection: { workspaceId: "default", citadelId: "citadel" }, citadelId: "citadel",
    before: structuredClone(settings), after: structuredClone(settings), mutations: [],
  };
}

test("Health navigation proof requires the exact native Local AI section in the same document and scope", () => {
  assert.equal(HEALTH_LOCAL_AI_HREF, "/settings/models?shell=cockpit#local-ai");
  assert.doesNotThrow(() => assertHealthNativeNavigation(proof()));
  for (const href of [
    "/settings/local-ai?shell=classic", "/settings/models?shell=classic#local-ai",
    "/settings/models?shell=cockpit", "/settings/models?shell=cockpit#llama-cpp-setup",
    "/settings/models?shell=cockpit&workspaceId=foreign#local-ai",
  ]) {
    assert.throws(() => assertHealthNativeNavigation({ ...proof(), url: `http://127.0.0.1:1234${href}` }), assert.AssertionError);
  }
  for (const change of [
    (value) => { value.documentRequestsAfter += 1; },
    (value) => { value.marker = undefined; },
    (value) => { value.selection.workspaceId = "foreign"; },
    (value) => { value.selection.citadelId = "foreign"; },
  ]) {
    const invalid = proof();
    change(invalid);
    assert.throws(() => assertHealthNativeNavigation(invalid), assert.AssertionError);
  }
});

test("Health inspection proof rejects any mutation or canonical runtime configuration change", () => {
  for (const change of [
    (value) => { value.mutations.push("/api/v1/llama-cpp/start"); },
    (value) => { value.after.revision += 1; },
    (value) => { value.after.llamaCpp.enabled = true; },
    (value) => { value.before.llamaCpp.enabled = true; value.after.llamaCpp.enabled = true; },
    (value) => { value.after.llamaCpp.autoStart = true; },
    (value) => { value.after.llamaCpp.managementMode = "external"; },
    (value) => { value.after.llamaCpp.modelPath = "unexpected-model.gguf"; },
    (value) => { value.after.llamaCpp.modelsRootPath = "foreign/models"; },
    (value) => { value.after.llamaCpp.command = "other-server"; },
    (value) => { value.after.llamaCpp.extraArgs.push("--unexpected"); },
    (value) => { value.after.llamaCpp.baseUrl = "http://127.0.0.1:8081/v1"; },
    (value) => { value.after.llamaCpp.ctxSize++; },
    (value) => { value.after.llamaCpp.flashAttention = true; },
  ]) {
    const invalid = proof();
    change(invalid);
    assert.throws(() => assertHealthNativeNavigation(invalid), assert.AssertionError);
  }
});

test("Health observation permits only probe freshness timestamps to advance", () => {
  const value = proof();
  value.after.llamaCpp.status.updatedAt = "2026-10-01T00:00:03.000Z";
  value.after.llamaCpp.status.leaseDiagnostics.evidence.lastProbe.at = "2026-10-01T00:00:03.000Z";
  assert.doesNotThrow(() => assertHealthNativeNavigation(value));
  for (const change of [
    status => { status.updatedAt = "invalid"; },
    status => { status.leaseDiagnostics.evidence.lastProbe.at = "invalid"; },
    status => { status.leaseDiagnostics.evidence.lastProbe.healthy = true; },
    status => { status.leaseDiagnostics.evidence.lastStart = { at: "2026-10-01T00:00:01.000Z", reason: "api", outcome: "requested" }; },
    status => { status.leaseDiagnostics.evidence.lastLease = { at: "2026-10-01T00:00:01.000Z", purpose: "chat", action: "released" }; },
    status => { status.leaseDiagnostics.evidence.lastExit = { at: "2026-10-01T00:00:01.000Z", unexpected: false }; },
    status => { status.leaseDiagnostics.evidence.lastRestart = { at: "2026-10-01T00:00:01.000Z", outcome: "attempting" }; },
  ]) {
    const invalid = structuredClone(value);
    change(invalid.after.llamaCpp.status);
    assert.throws(() => assertHealthNativeNavigation(invalid), assert.AssertionError);
  }
});

test("Health proof requires stopped unowned idle runtime with no leases or start demand", () => {
  for (const change of [
    status => { status.enabled = true; },
    status => { status.desiredState = "running"; },
    status => { status.processState = "starting"; },
    status => { status.processState = "running"; },
    status => { status.healthy = true; },
    status => { status.pid = 1234; },
    status => { status.leaseDiagnostics.state = "starting"; },
    status => { status.leaseDiagnostics.ownership = "owned"; },
    status => { status.leaseDiagnostics.ownership = "external"; },
    status => { status.leaseDiagnostics.activeLeaseCount = 1; },
    status => { status.leaseDiagnostics.purposes.push({ purpose: "chat_completion", count: 1 }); },
    status => { status.leaseDiagnostics.persistentDemand.manual = true; },
    status => { status.leaseDiagnostics.persistentDemand.api = true; },
    status => { status.leaseDiagnostics.persistentDemand.autostart = true; },
  ]) {
    const invalid = proof();
    // Even unchanged active status on both reads must not count as a no-start fixture.
    change(invalid.before.llamaCpp.status);
    change(invalid.after.llamaCpp.status);
    assert.throws(() => assertHealthNativeNavigation(invalid), assert.AssertionError);
  }
});
