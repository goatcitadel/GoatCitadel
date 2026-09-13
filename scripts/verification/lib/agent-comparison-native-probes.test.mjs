import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import { createNativeConformanceProbes, evaluateNativeConformancePolicy } from "./agent-comparison-native-probes.mjs";

it("fails conformance when observed access contradicts the configured policy", () => {
  const policy = { files: "workspace_only", terminal: "allowlist_miss_approval" };
  const evidence = {
    workspace_read: { outcome: "allowed" },
    sibling_read: { outcome: "denied" },
    terminal: { outcome: "approval_unavailable" },
  };
  assert.equal(evaluateNativeConformancePolicy(evidence, policy, true).status, "matched");
  assert.equal(
    evaluateNativeConformancePolicy({ ...evidence, terminal: { outcome: "allowed" } }, policy, true).status,
    "mismatch",
  );
  assert.equal(
    evaluateNativeConformancePolicy({ ...evidence, sibling_read: { outcome: "allowed" } }, policy, true).status,
    "mismatch",
  );
  assert.equal(
    evaluateNativeConformancePolicy({ ...evidence, terminal: { outcome: "inconclusive" } }, policy, true).status,
    "unverified",
  );
  assert.equal(evaluateNativeConformancePolicy(evidence, policy, false).status, "matched");
});

const workspace = path.resolve("test workspace $() `literal`");
const tools = [
  { type: "function", function: { name: "read", parameters: { properties: { path: { type: "string" } } } } },
  {
    type: "function",
    function: {
      name: "exec",
      parameters: { properties: { command: { type: "string" }, workdir: { type: "string" } } },
    },
  },
];
const body = (messages = []) => ({ tools, messages });
const result = (id, content) => ({ role: "tool", tool_call_id: `callcomparison${id.replaceAll("_", "")}`, content });

it("correlates actual tool results and replays the same bounded request for a provider retry", () => {
  const probe = createNativeConformanceProbes({ workspace, permissions: true });
  const first = probe.respond(body());
  assert.deepEqual(probe.respond(body()), first);
  probe.respond({ messages: [], tools: [] });
  assert.deepEqual(probe.respond(body()), first);
  const marker = probe.fixtures[0].content;
  probe.respond(body([{ role: "assistant", content: marker }, result("unrelated", marker)]));
  assert.equal(probe.evidence().workspace_read.outcome, "inconclusive");
  const second = probe.respond(body([result("workspace_read", marker)]));
  assert.equal(second.tool_calls[0].id, "callcomparisonsiblingread");
  assert.equal(probe.evidence().workspace_read.outcome, "allowed");
  assert.equal(
    JSON.parse(second.tool_calls[0].function.arguments).path,
    path.join(path.dirname(workspace), "sibling-fixture.txt"),
  );
});

it("retains denial and approval evidence without mistaking unavailable execution for refusal", () => {
  const probe = createNativeConformanceProbes({ workspace, permissions: true });
  const messages = [];
  probe.respond(body(messages));
  messages.push(result("workspace_read", probe.fixtures[0].content));
  probe.respond(body(messages));
  messages.push(result("sibling_read", "Path escapes workspace root"));
  const terminal = probe.respond(body(messages));
  assert.deepEqual(JSON.parse(terminal.tool_calls[0].function.arguments), {
    command: "node ./terminal-probe.cjs",
    workdir: workspace,
  });
  messages.push(result("terminal", "Approval required"));
  assert.equal(probe.respond(body(messages)).content, "LOCAL_PROFILE_OK");
  assert.equal(probe.evidence().sibling_read.outcome, "denied");
  assert.equal(probe.evidence().terminal.outcome, "approval_required");
  messages[messages.length - 1] = result("terminal", "Sandbox runtime is unavailable");
  probe.respond(body(messages));
  assert.equal(probe.evidence().terminal.outcome, "inconclusive");
  messages[messages.length - 1] = result("terminal", "Exec approval registration failed: Gateway not reachable");
  probe.respond(body(messages));
  assert.equal(probe.evidence().terminal.outcome, "approval_unavailable");
});

it("requires the independently read exact terminal marker even if a tool quotes the script", () => {
  const probe = createNativeConformanceProbes({ workspace, permissions: true });
  const messages = [];
  for (const [index, id] of ["workspace_read", "sibling_read"].entries()) {
    probe.respond(body(messages));
    messages.push(result(id, probe.fixtures[index].content));
  }
  probe.respond(body(messages));
  const script = probe.fixtures.find((fixture) => fixture.filename.endsWith(".cjs")).content;
  const marker = /CONTROLLED_TERMINAL_[a-f0-9-]+/u.exec(script)[0];
  messages.push(result("terminal", `Failed to run script: ${script}`));
  probe.respond(body(messages));
  assert.equal(probe.evidence().terminal.outcome, "inconclusive");
  assert.equal(probe.evidence(`${marker}\n`).terminal.outcome, "inconclusive");
  assert.equal(probe.evidence(marker).terminal.outcome, "allowed");
  assert.equal(probe.evidence().sibling_read.outcome, "allowed");
  assert.match(script, /flag: "wx"/u);
});

it("preserves the file-only probe and reports missing tool schemas as unsupported", () => {
  const simple = createNativeConformanceProbes({ workspace });
  assert.equal(simple.fixtures.length, 1);
  assert.deepEqual(Object.keys(simple.evidence()), ["workspace_read"]);
  simple.respond({ messages: [], tools: [{ function: { name: "read", parameters: {} } }] });
  assert.equal(simple.evidence().workspace_read.outcome, "unsupported");
  const probe = createNativeConformanceProbes({ workspace, permissions: true });
  probe.respond({ messages: [], tools: [] });
  assert.ok(Object.values(probe.evidence()).every((entry) => entry.outcome === "inconclusive" && !entry.requested));
});
