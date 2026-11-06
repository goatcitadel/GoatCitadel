import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import * as owner from "./cockpit-performance-proof.mjs";

// Namespace lookup keeps an absent implementation a behavioral RED, not a module collection error.
function collector(options = {}) {
  assert.equal(typeof owner.createStartupReadDiagnostics, "function", "Actual performance owner must project startup packet descriptors");
  return owner.createStartupReadDiagnostics({ fixture: { workspaceId: "synthetic-workspace-private", sessionId: "synthetic-session-private", citadelId: "synthetic-citadel-private" }, ...options });
}
const packet = (paths) => "http://127.0.0.1:8787/api/v1/startup-reads?" + new URLSearchParams({ reads: JSON.stringify(paths.map((path, index) => ({ path, correlationId: "private-correlation-" + index, originSurface: "private-origin" }))) });
const workspacePath = "/api/v1/chat/sessions?workspaceId=synthetic-workspace-private&scope=all&limit=200&includeActivity=true&mode=chat";
const start = (c, url, at = 0, method = "GET") => c.start({ url, method, at });
const serialized = (value) => JSON.stringify(value);

// Intended API is an observer only: no transport, scheduler, response body or auth is supplied.
test("records actual ordered packets and normalized direct fallback without merging dependency waves", () => {
  const c = collector();
  const first = start(c, packet([workspacePath, "/api/v1/chat/sessions/synthetic-session-private/core-state"]), 10);
  c.finish(first, { at: 40, status: 200 });
  const second = start(c, packet([workspacePath]), 45);
  const direct = start(c, "http://127.0.0.1:8787" + workspacePath, 46);
  c.finish(second, { at: 70, status: 405 });
  c.finish(direct, { at: 75, status: 200 });
  const report = c.snapshot();
  assert.equal(report.complete, true);
  assert.deepEqual(report.events.map(({ ordinal, kind, at, completedAt, status }) => ({ ordinal, kind, at, completedAt, status })), [
    { ordinal: 1, kind: "batch", at: 10, completedAt: 40, status: 200 },
    { ordinal: 2, kind: "batch", at: 45, completedAt: 70, status: 405 },
    { ordinal: 3, kind: "direct", at: 46, completedAt: 75, status: 200 },
  ]);
  assert.equal(report.events[0].descriptors.length, 2);
  assert.deepEqual(report.events[0].descriptors[0], report.events[1].descriptors[0]);
  assert.deepEqual(report.events[1].descriptors[0], report.events[2].descriptors[0]);
  assert.equal(report.events[0].descriptors[1].route, "/api/v1/chat/sessions/:session/core-state");
  assert.equal(report.events[0].descriptors[1].scope.sessionId, "session:fixture");
  assert.equal(report.events[0].descriptors[0].scope.workspaceId, "workspace:fixture");
  assert.deepEqual(report.events[0].descriptors[0].settings, { includeActivity: true, limit: 200, mode: "chat", scope: "all" });
  assert.equal(report.counts.observedDescriptors, 4);
  assert.equal(report.counts.retainedDescriptors, 4);
});

test("distinguishes overlapping repeated descriptors from repetition after completion", () => {
  const c = collector();
  const a = start(c, packet([workspacePath]), 0);
  const b = start(c, packet([workspacePath]), 1);
  c.finish(a, { at: 2, status: 200 });
  c.finish(b, { at: 3, status: 200 });
  start(c, packet([workspacePath]), 4);
  const events = c.snapshot().events;
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.at), [0, 1, 4]);
  assert.deepEqual(events.map((event) => event.completedAt), [2, 3, null]);
});

test("aliases foreign scope by stable local ordinal without leaking IDs, URLs, credentials or correlation", () => {
  const c = collector();
  start(c, packet(["/api/v1/chat/sessions/private-session-one/control?workspaceId=private-workspace-one", "/api/v1/chat/sessions/private-session-two/control?workspaceId=private-workspace-one"]));
  start(c, packet(["/api/v1/chat/sessions/private-session-one/control?workspaceId=private-workspace-one"]), 1);
  const report = c.snapshot();
  const descriptors = report.events.flatMap((event) => event.descriptors);
  assert.equal(descriptors[0].scope.sessionId, "session:1");
  assert.equal(descriptors[1].scope.sessionId, "session:2");
  assert.equal(descriptors[2].scope.sessionId, "session:1");
  assert.equal(descriptors[0].scope.workspaceId, "workspace:1");
  const output = serialized(report);
  for (const secret of ["private-session", "private-workspace", "127.0.0.1", "private-correlation", "private-origin", "synthetic-session-private", "synthetic-workspace-private"]) assert.equal(output.includes(secret), false);
});

test("unknown query keys, sensitive text settings, malformed rows and unknown routes become counted gaps", () => {
  const c = collector();
  start(c, packet(["/api/v1/chat/sessions?q=password%3Dsecret-search-value&workspaceId=synthetic-workspace-private", "/api/v1/unknown/private-route-secret?token=private-token-secret"]));
  start(c, "http://localhost/api/v1/startup-reads?reads=%7Bbroken-secret");
  start(c, "http://localhost/api/v1/startup-reads?reads=" + encodeURIComponent(JSON.stringify([{ path: workspacePath, correlationId: "id", unexpected: "private-row-secret" }])));
  const report = c.snapshot();
  assert.equal(report.complete, false);
  assert.ok(report.counts.malformedPackets >= 2);
  assert.ok(report.gaps.some((entry) => entry.reason === "query_not_projectable"));
  assert.ok(report.gaps.some((entry) => entry.reason === "route_not_projectable"));
  for (const secret of ["secret-search-value", "private-route-secret", "private-token-secret", "broken-secret", "private-row-secret", "password", "token"]) assert.equal(serialized(report).includes(secret), false);
});

test("caps raw query before JSON parse, descriptor count before projection, events and serialized bytes with honest omissions", () => {
  const c = collector({ maxQueryBytes: 900, maxDescriptors: 2, maxEvents: 2, maxBytes: 2048 });
  start(c, "http://localhost/api/v1/startup-reads?reads=" + "X".repeat(901));
  start(c, packet([workspacePath, workspacePath, workspacePath]), 1);
  for (let index = 0; index < 9; index++) start(c, packet([workspacePath]), index + 2);
  const report = c.snapshot();
  assert.equal(report.complete, false);
  assert.equal(report.counts.observedEvents, 11);
  assert.ok(report.counts.omittedEvents > 0);
  assert.ok(report.counts.omittedDescriptors >= 1);
  assert.ok(report.events.length <= 2);
  assert.ok(Buffer.byteLength(serialized(report)) <= 2048);
  assert.ok(report.gaps.some((entry) => entry.reason === "query_limit"));
  assert.ok(report.gaps.some((entry) => entry.reason === "descriptor_limit"));
});

test("ignores non-GET, SSE and unrelated static assets without changing finite observer accounting", () => {
  const c = collector();
  for (const [url, method] of [["http://localhost/api/v1/chat/sessions", "POST"], ["http://localhost/api/v1/events/stream", "GET"], ["http://localhost/assets/index.js", "GET"]]) assert.equal(start(c, url, 0, method), null);
  const id = start(c, packet([workspacePath]), 2);
  c.finish(id, { at: Number.NaN, status: Infinity });
  c.finish("unknown", { at: 5, status: 200 });
  const report = c.snapshot();
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].completedAt, null);
  assert.equal(report.complete, false);
  assert.equal(serialized(report).includes("NaN"), false);
  assert.equal(serialized(report).includes("Infinity"), false);
});

test("canonical redaction runs before bounded write and diagnostic failures preserve original acceptance", async () => {
  assert.equal(typeof owner.persistStartupReadDiagnostics, "function", "Actual owner must isolate optional diagnostics writer failures");
  const c = collector(); const handle = start(c, packet([workspacePath])); c.finish(handle, { at: 1, status: 200 });
  const acceptance = Object.freeze({ passed: false, failures: Object.freeze(["startupRequests: 23 exceeds 20"]) });
  const events = [], written = [];
  const result = await owner.persistStartupReadDiagnostics({ collector: c, file: "synthetic-output.json", acceptance }, {
    redact: async (text) => { events.push("redact"); return text; },
    writeJson: async (_file, value) => { events.push("write"); written.push(value); },
  });
  assert.deepEqual(events, ["redact", "write"]);
  assert.equal(result.acceptance, acceptance);
  assert.equal(result.complete, true);
  assert.equal(written.length, 1);
  for (const failure of ["redact", "write"]) {
    const output = await owner.persistStartupReadDiagnostics({ collector: c, file: "synthetic-output.json", acceptance }, {
      redact: async (text) => { if (failure === "redact") throw new Error("private-redaction-secret"); return text; },
      writeJson: async () => { throw new Error("private-writer-secret"); },
    });
    assert.equal(output.acceptance, acceptance);
    assert.equal(output.complete, false);
    assert.equal(serialized(output).includes("private-"), false);
  }
});

test("pending completion is explicit at actual snapshot/persistence boundaries and valid finish resolves it without phantom counts", async () => {
  const c = collector(); const id = start(c, packet([workspacePath]), 5);
  const pending = c.snapshot();
  assert.equal(pending.complete, false, "A packet without completion cannot certify complete causal evidence");
  assert.equal(pending.projectionComplete, true);
  assert.equal(pending.completionComplete, false);
  assert.equal(pending.counts.pendingEvents, 1);
  assert.equal(c.snapshot().counts.pendingEvents, 1);
  const written = [];
  const result = await owner.persistStartupReadDiagnostics({ collector:c, file:"pending.json", acceptance:{passed:false} }, {
    redact:async text=>text, writeJson:async (_file,report)=>written.push(report),
  });
  assert.equal(result.complete, false); assert.equal(result.written, true);
  assert.equal(written[0].counts.pendingEvents, 1);
  c.finish(id,{at:9,status:200});
  assert.equal(c.snapshot().complete, true); assert.equal(c.snapshot().counts.pendingEvents, 0);
  const invalid = collector(); const invalidId = start(invalid,packet([workspacePath]),5);
  invalid.finish(invalidId,{at:4,status:200});
  assert.equal(invalid.snapshot().complete,false); assert.equal(invalid.snapshot().counts.pendingEvents,1);
  assert.equal(invalid.snapshot().projectionComplete,false);
});

test("path owner cannot be overwritten by query scope, including equal identity channels", () => {
  for(const [a,b] of [
    ["/api/v1/chat/sessions/private-A/control?sessionId=private-B","/api/v1/chat/sessions/private-C/control?sessionId=private-B"],
    ["/api/v1/agentic/runs/private-A/tree?runId=private-B","/api/v1/agentic/runs/private-C/tree?runId=private-B"],
    ["/api/v1/citadels/private-A/structure?citadelId=private-A","/api/v1/citadels/private-C/structure?citadelId=private-C"],
  ]) {
    const c = collector(); const id = start(c,packet([a,b])); c.finish(id,{at:1,status:200});
    const report=c.snapshot();
    assert.equal(report.complete,false,"Duplicate owner identity channels require an explicit gap");
    assert.ok(report.gaps.some(gap=>gap.reason==="scope_identity_collision"));
    assert.deepEqual(report.events[0].descriptors,[],"Conflicting/equal duplicate channels must not produce falsely equivalent descriptors");
    assert.equal(serialized(report).includes("private-"),false);
  }
  const malformed=collector(); start(malformed,"http://localhost/api/v1/startup-reads?reads=broken");
  assert.equal(malformed.snapshot().descriptorCountKnown,false,"Malformed JSON cardinality is unmeasured");
});

test("actual performance save retains a fixed optional diagnostic gap while preserving its original lane failure", async () => {
  const writes=[],results=[];
  const page={on(){},async addInitScript(){},async goto(){throw new Error("Controlled original performance failure");}};
  const browser={async newContext(){return {async addInitScript(){},async newPage(){return page;},async close(){}};}};
  await owner.runCockpitPerformanceProof({context:{artifactRoot:"synthetic-artifacts"},browser,stack:{uiUrl:"http://localhost",gatewayUrl:"http://localhost"},
    fixture:{workspaceId:"synthetic-workspace-private",sessionId:"synthetic-session-private",citadelId:"synthetic-citadel-private"},
    deps:{path,runScenario:async (_context,_definition,run)=>results.push(await run()),
      installMissionControlNextBrowserState:async()=>{},buildVerificationUiUrl:(base,route)=>new URL(route,base).href,
      writeJson:async (file,value)=>{if(file.endsWith("-startup-reads.json"))throw new Error("private-companion-writer-secret");writes.push({file,value});},
      relativeToRun:(_context,file)=>path.basename(file),attachBrowserLogging:()=>({}),captureBrowserArtifacts:async()=>({diagnostics:[]}),
    }});
  assert.equal(results.length,3); assert.equal(writes.length,3);
  for(let index=0;index<3;index++) {
    assert.equal(results[index].status,"failed");
    assert.deepEqual(results[index].notes,["Controlled original performance failure"]);
    assert.deepEqual(writes[index].value.acceptance,{passed:false,failures:["Controlled original performance failure"]});
    assert.deepEqual(writes[index].value.startupReadDiagnostic,{written:false,complete:false,gapReason:"diagnostic_write_failure"});
    assert.equal(results[index].artifacts.diagnostics.some(file=>file.endsWith("-startup-reads.json")),false);
  }
  assert.equal(serialized({writes,results}).includes("private-companion-writer-secret"),false);
});
