import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it } from "node:test";
import {
  buildNativeComparisonProfile,
  NATIVE_COMPARISON_PINS,
  NATIVE_PROFILE_SLOTS,
} from "./agent-comparison-native-profile.mjs";
import { nativeComparisonEnvironment } from "./agent-comparison-native-driver.mjs";
import { executeGoatComparisonTurn } from "./agent-comparison-goat-api.mjs";
import {
  AssistantConfigInputSchema,
  ToolPolicyConfigSchema,
  BudgetConfigSchema,
  LlmConfigFileSchema,
} from "../../../packages/contracts/dist/index.js";
import { classifyShellRisk } from "../../../packages/policy-engine/dist/sandbox/shell-risk-gate.js";

const profile = {
  revision: NATIVE_COMPARISON_PINS.goatcitadel,
  provider: "fixture",
  model: "fixture-model",
  tools: ["files", "terminal"],
  grants: ["test-workspace"],
  reasoning: "high",
  contextTokens: 8192,
  outputTokens: 256,
  maxTaskMs: 30_000,
};

it("validates the fresh GoatCitadel config against canonical schemas and preserves shell approval", () => {
  const plan = buildNativeComparisonProfile("goatcitadel", profile);
  AssistantConfigInputSchema.parse(plan.config.assistant);
  const policy = ToolPolicyConfigSchema.parse(plan.config.toolPolicy);
  BudgetConfigSchema.parse(plan.config.budgets);
  LlmConfigFileSchema.parse(plan.config.llm);
  assert.deepEqual(policy.sandbox.writeJailRoots, [NATIVE_PROFILE_SLOTS.workspace]);
  assert.equal(plan.config.assistant.workspaceDir, NATIVE_PROFILE_SLOTS.workspace);
  assert.equal(classifyShellRisk("node --test fixture.mjs", policy.sandbox.riskyShellPatterns).risky, true);
  assert.equal(plan.config.llm.defaultThinkingLevel, "extended");
  assert.throws(() => buildNativeComparisonProfile("goatcitadel", { ...profile, reasoning: "minimal" }), /exactly/);
  const env = nativeComparisonEnvironment({
    product: "goatcitadel",
    homeDirectory: "/fresh",
    stateDirectory: "/fresh/state",
    executablePath: process.execPath,
    checkoutRoot: "/clean",
    proxyKey: "proxy-only",
    ambient: { OPENAI_API_KEY: "private", GOATCITADEL_LOCAL_ENV_FILE: "/personal.env" },
  });
  assert.equal(env.GOATCITADEL_DISABLE_SECRET_STORE, "true");
  assert.equal(env.GOATCITADEL_AUTH_MODE, "token");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GOATCITADEL_LOCAL_ENV_FILE, undefined);
  const supervised = buildNativeComparisonProfile("goatcitadel", profile, "max_completion_tokens", {
    approvalGateway: true,
  });
  assert.notEqual(supervised.planSha256, plan.planSha256);
  assert.deepEqual(supervised.config.toolPolicy, plan.config.toolPolicy);
});

const nativeApprovalId = "11111111-1111-4111-8111-111111111111";
function supervisedFixture(overrides = {}) {
  const requests = [],
    retained = [];
  let resolved = false,
    durableReads = 0,
    childReads = 0,
    stopped = 0;
  const approval = {
    approvalId: nativeApprovalId,
    kind: "tool.invoke",
    status: "pending",
    preview: { command: "node fixture.cjs" },
    linkage: {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      durableRunId: "wait-1",
    },
  };
  const waitForEvent = { eventKey: "approval.resolved", correlationId: nativeApprovalId };
  const trace = () => ({
    turnId: "turn-1",
    sessionId: "session-1",
    status: resolved ? "completed" : "waiting_for_approval",
    durable: { runId: "run-1", status: resolved ? "running" : "waiting" },
  });
  const input = {
    baseUrl: "http://127.0.0.1:32123/",
    token: "a".repeat(40),
    workspace: "/fixture",
    prompt: "Run task",
    profile: { model: "fixture-model", thinkingLevel: "off" },
    pollMs: 10,
    retain: async (name, body) => {
      retained.push({ name, body });
    },
    fetchImpl: async (url, init) => {
      const route = new URL(url).pathname.replace("/api/v1", "");
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ route, method: init.method, body });
      let response;
      if (route === "/workspaces") response = { workspaceId: "workspace-1" };
      else if (route === "/chat/projects") response = { projectId: "project-1" };
      else if (route === "/chat/sessions") response = { sessionId: "session-1" };
      else if (route.endsWith("/route-preflight"))
        response = { decision: { effectiveProviderId: "comparison", effectiveModel: "fixture-model" } };
      else if (route.endsWith("/agent-send")) response = { turnId: "turn-1", trace: trace() };
      else if (route.endsWith("/thread"))
        response = { sessionId: "session-1", turns: [{ turnId: "turn-1", trace: trace() }] };
      else if (route === "/approvals")
        response = { items: [approval, { ...approval, approvalId: "unrelated", linkage: { sessionId: "different" } }] };
      else if (route.endsWith("/replay"))
        response = { approval: structuredClone(approval), durableRunId: "wait-1", ...overrides.replay };
      else if (route.endsWith("/resolve")) {
        assert.ok(
          retained.some((entry) => entry.name.endsWith("-intent")),
          "Intent must precede native resolution.",
        );
        resolved = true;
        if (overrides.lostReply) throw new Error("controlled response loss");
        response = { approval: { ...approval, status: body.decision === "approve" ? "approved" : "rejected" } };
      } else if (route === "/durable/runs/wait-1") {
        response = {
          runId: "wait-1",
          workflowKey: "approval.wait",
          status: "waiting",
          payload: { approvalId: nativeApprovalId },
          metadata: { approvalId: nativeApprovalId, waitForEvent },
          ...overrides.waitRun,
        };
      } else if (route === "/durable/runs/run-1") {
        durableReads++;
        response = {
          runId: "run-1",
          workflowKey: "chat.turn.execute",
          status: resolved ? (durableReads >= 4 ? "completed" : "running") : "waiting",
          payload: { workspaceId: "workspace-1", sessionId: "session-1", turnId: "turn-1" },
          metadata: {
            waitForEvent,
            generalChatPostCommit: {
              parentLocalEffectsStatus: "settled",
              durableEffectRunIds: { background_review: "child-1" },
            },
          },
          ...overrides.chatRun,
        };
      } else if (route === "/durable/runs/child-1") {
        childReads++;
        response = {
          runId: "child-1",
          workflowKey: "chat.post_commit.effect",
          status: childReads >= 2 ? "completed" : "running",
          payload: {
            parentRunId: "run-1",
            input: { workspaceId: "workspace-1", sessionId: "session-1", turnId: "turn-1" },
          },
          ...overrides.childRun,
        };
      } else throw new Error(`Unexpected fixture request: ${route}`);
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    },
    onApprovalReady: async (control) => {
      const pending = await control.pending();
      assert.deepEqual(
        pending.approvals.map((entry) => entry.id),
        [nativeApprovalId],
      );
      await control.resolve({ approvalId: nativeApprovalId, decision: overrides.decision ?? "allow-once" });
      return {
        stop: async () => {
          stopped++;
        },
      };
    },
  };
  return {
    input,
    requests,
    retained,
    get durableReads() {
      return durableReads;
    },
    get stopped() {
      return stopped;
    },
  };
}

for (const decision of ["allow-once", "deny"])
  it(`forwards ${decision} through the native owner and waits beyond a completed Chat projection`, async () => {
    const f = supervisedFixture({ decision });
    const result = await executeGoatComparisonTurn(f.input);
    assert.equal(result.taskOutcome, "unverified");
    assert.equal(result.thread.turns[0].trace.status, "completed");
    assert.equal(f.durableReads, 5);
    assert.equal(f.stopped, 1);
    const resolutions = f.requests.filter((entry) => entry.route.endsWith("/resolve"));
    assert.equal(resolutions.length, 1);
    assert.deepEqual(resolutions[0].body, { decision: decision === "allow-once" ? "approve" : "reject" });
    assert.equal(f.retained.at(-1).name, "thread-final");
  });

it("rejects a post-turn child from another owner instead of reporting closeout", async () => {
  const f = supervisedFixture({ childRun: { payload: { parentRunId: "different-run" } } });
  await assert.rejects(executeGoatComparisonTurn(f.input), /post-turn child changed scope/);
  assert.equal(
    f.retained.some((entry) => entry.name === "thread-final"),
    false,
  );
  assert.equal(f.stopped, 1);
});

it("refuses stale or another durable run's approval before mutation", async () => {
  for (const replay of [
    { durableRunId: "different-run" },
    { approval: { approvalId: nativeApprovalId, status: "approved" } },
  ]) {
    const f = supervisedFixture({ replay });
    await assert.rejects(executeGoatComparisonTurn(f.input), /exact durable Chat turn/);
    assert.equal(
      f.requests.some((entry) => entry.route.endsWith("/resolve")),
      false,
    );
    assert.equal(
      f.retained.some((entry) => entry.name.endsWith("-intent")),
      false,
    );
  }
});

it("rejects mismatched approval wait owners and Chat correlations before a decision", async () => {
  for (const overrides of [
    { waitRun: { workflowKey: "chat.turn.execute" } },
    { waitRun: { payload: { approvalId: "different" } } },
    { waitRun: { metadata: { approvalId: "different" } } },
    { waitRun: { status: "completed" } },
    { chatRun: { payload: { workspaceId: "other", sessionId: "session-1", turnId: "turn-1" } } },
    { chatRun: { metadata: { waitForEvent: { eventKey: "approval.resolved", correlationId: "different" } } } },
    { chatRun: { status: "running" } },
  ]) {
    const f = supervisedFixture(overrides);
    await assert.rejects(executeGoatComparisonTurn(f.input), /exact durable Chat turn/);
    assert.equal(
      f.requests.some((entry) => entry.route.endsWith("/resolve")),
      false,
    );
    assert.equal(
      f.retained.some((entry) => entry.name.endsWith("-intent")),
      false,
    );
  }
});

it("retains an uncertain native approval response and never retries it", async () => {
  const f = supervisedFixture({ lostReply: true });
  await assert.rejects(executeGoatComparisonTurn(f.input), /controlled response loss/);
  assert.equal(f.requests.filter((entry) => entry.route.endsWith("/resolve")).length, 1);
  assert.ok(f.retained.some((entry) => entry.name.endsWith("-unconfirmed") && entry.body.status === "unconfirmed"));
});

it("closing the native console cancels polling without issuing a decision", async () => {
  const f = supervisedFixture();
  f.input.onApprovalReady = async ({ onClosed }) => {
    onClosed();
    return { stop: async () => {} };
  };
  await assert.rejects(executeGoatComparisonTurn(f.input), { name: "AbortError" });
  assert.equal(
    f.requests.some((entry) => entry.route.endsWith("/resolve")),
    false,
  );
});

async function gateway(t, differentProvider = false) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      key: req.headers["idempotency-key"],
      body: body ? JSON.parse(body) : null,
    });
    const replies = {
      "/api/v1/workspaces": { workspaceId: "workspace-1" },
      "/api/v1/chat/projects": { projectId: "project-1" },
      "/api/v1/chat/sessions": { sessionId: "session-1" },
      "/api/v1/chat/sessions/session-1/route-preflight": {
        decision: { effectiveProviderId: differentProvider ? "other" : "comparison", effectiveModel: "fixture-model" },
      },
      "/api/v1/chat/sessions/session-1/agent-send": { status: "waiting_approval", approvalId: "approval-1" },
      "/api/v1/chat/sessions/session-1/thread": {
        turns: [{ turnId: "turn-1", trace: { status: "waiting_approval" } }],
      },
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(replies[req.url] ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/` };
}

it("retains authenticated native HTTP evidence and leaves approval waiting", async (t) => {
  const { baseUrl, requests } = await gateway(t);
  const retained = [];
  const result = await executeGoatComparisonTurn({
    baseUrl,
    token: "a".repeat(40),
    workspace: "/fixture",
    prompt: "Run task",
    profile: { model: "fixture-model", thinkingLevel: "extended" },
    retain: async (name, body) => retained.push({ name, body }),
  });
  assert.equal(result.result.status, "waiting_approval");
  assert.equal(result.taskOutcome, "unverified");
  assert.equal(requests.length, 6);
  assert.equal(new Set(requests.map((r) => r.key)).size, 6);
  assert.ok(requests.every((r) => r.authorization === `Bearer ${"a".repeat(40)}`));
  assert.ok(requests.every((r) => !r.url.includes("approvals")));
  assert.equal(requests.find((r) => r.url === "/api/v1/chat/projects").body.workspacePath, ".");
  assert.equal(retained.at(-1).name, "thread");
});

it("retains a changed route and stops before agent-send", async (t) => {
  const { baseUrl, requests } = await gateway(t, true);
  await assert.rejects(
    executeGoatComparisonTurn({
      baseUrl,
      token: "a".repeat(40),
      workspace: "/fixture",
      prompt: "Run task",
      profile: { model: "fixture-model", thinkingLevel: "off" },
      retain: async () => {},
    }),
    /different provider/,
  );
  assert.equal(requests.length, 4);
  await assert.rejects(
    executeGoatComparisonTurn({ baseUrl: "https://other.invalid/", token: "a".repeat(40) }),
    /owned loopback/,
  );
});
