import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcceptanceActions, revision } from "./agent-comparison-goat-acceptance.mjs";
import { runFeatureAcceptance } from "./agent-comparison-acceptance.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";
import { sha256 } from "./agent-comparison.mjs";
import { FEATURE_ACCEPTANCE_TASKS } from "./agent-comparison-acceptance-fixtures.mjs";

// These HTTP responses are controlled API conformance evidence, never live
// product acceptance. Public-route composition is separately tested in Gateway.
async function fixture(t, taskId = "web_research") {
  const root = await mkdtemp(path.join(tmpdir(), "goat-native-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    evidence = path.join(root, "evidence");
  await mkdir(workspace);
  await mkdir(evidence);
  const binding = {
    executionId: "execution",
    manifestSha256: sha256("manifest"),
    cellId: `goatcitadel:${taskId}:1`,
    revision,
    effectiveConfigSha256: sha256("config"),
    fixtureSha256: sha256("fixtures"),
  };
  await writeFile(
    path.join(evidence, "session-start.json"),
    JSON.stringify({ ...binding, source: "controlled_fixture" }),
  );
  const connectionFile = path.join(root, "connection.json");
  await writeFile(
    connectionFile,
    JSON.stringify({ baseUrl: "http://127.0.0.1:9999/v1", apiKey: "short-lived-proxy-key", model: "fixture-model" }),
  );
  for (const [name, content] of Object.entries(FEATURE_ACCEPTANCE_TASKS.find((task) => task.id === taskId).files)) {
    await mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await writeFile(path.join(workspace, name), content);
  }
  const requests = [],
    state = { stops: 0, closes: 0, approved: false, runtime: 1, now: new Date().toISOString() };
  const runtime = () => ({
    runtimeId: `runtime-${state.runtime}`,
    stateId: "owned-db",
    revision,
    workspace,
    configurationSha256: sha256("config"),
    baseUrl: "http://127.0.0.1:8789/",
    token: "g".repeat(40),
  });
  const supervisor = {
    start: async () => runtime(),
    stop: async () => {
      state.stops++;
    },
    restart: async () => {
      state.runtime++;
      return runtime();
    },
    reviewPermissions: async ({ configurationSha256 }) => ({
      configurationSha256,
      reviewedBy: "operator",
      reviewedAt: state.now,
      policy: {
        files: "workspace_only",
        terminal: "disabled",
        skills: "disabled",
        schedule: taskId === "scheduled_agent_work" ? "per_send_approval" : "disabled",
      },
    }),
    reviewSources: async ({ artifact, artifactSha256 }) => ({
      reviewerKind: "human",
      reviewerId: "operator",
      artifactSha256,
      claims: artifact.claims.map((claim) => ({ claimId: claim.id, claimSha256: sha256(claim), supported: true })),
      conflicts: [],
      conflictSearchCompleted: true,
    }),
    approve: async ({ approval }) => ({
      actorKind: "human",
      actorId: "operator",
      approvalId: approval.approvalId,
      decision: "approve",
    }),
    authorizeSchedule: async () => ({
      actorKind: "human",
      actorId: "operator",
      channelKey: "telegram",
      connectionId: "connection",
      target: "123",
      schedule: "* * * * * UTC",
      scheduledFor: state.scheduledFor,
    }),
    armPreDispatchFailure: async ({ runtimeId, providerId }) => ({
      runtimeId,
      providerId,
      boundary: "before_upstream_forward",
      controlled: true,
      maxFaults: 1,
    }),
    observeProviderFault: async ({ runtimeId }) => ({
      runtimeId,
      cellId: binding.cellId,
      controlled: true,
      boundary: "before_upstream_forward",
      nativeTransportReachedFixture: true,
      upstreamForwarded: false,
      status: 503,
      usefulOutputBytes: 0,
      transportReceiptId: "controlled-fault",
      requestSha256: sha256("controlled-request"),
      budgetSequence: 1,
      startedAt: state.now,
      finishedAt: new Date(Date.parse(state.now) + 1).toISOString(),
    }),
    armUncertainEffect: async () => {
      throw new Error("No controlled external transport configured.");
    },
    observeEffectTransport: async () => {
      throw new Error("No controlled external transport configured.");
    },
  };
  const urls = [
    "https://www.postgresql.org/docs/current/transaction-iso.html",
    "https://www.sqlite.org/isolation.html",
  ];
  const answer = {
    claims: urls.map((url, index) => ({
      id: `claim${index}`,
      url,
      text: `isolation claim ${index}`,
      quote: `source ${index}`,
    })),
    conflicts: [],
  };
  const tools = [
    {
      toolRunId: "search",
      toolName: "browser.search",
      status: "executed",
      args: { query: "primary transaction isolation" },
      result: { results: urls.map((url) => ({ url })) },
      finishedAt: state.now,
    },
    ...urls.map((url, index) => ({
      toolRunId: `read${index}`,
      toolName: "browser.extract",
      status: "executed",
      args: { url },
      result: { status: 200, text: `source ${index}` },
      finishedAt: state.now,
    })),
  ];
  const turn = {
    turnId: "turn",
    trace: {
      sessionId: "session",
      turnId: "turn",
      durable: { runId: "run" },
      status: "completed",
      startedAt: state.now,
      toolRuns: tools,
      routing: { primaryProviderId: "comparison", effectiveProviderId: "comparison-fallback", fallbackUsed: true },
    },
  };
  const owner = {
    runId: "run",
    workflowKey: "chat.turn.execute",
    status: "completed",
    payload: { workspaceId: "workspace", sessionId: "session", turnId: "turn" },
    metadata: { chatTurnAdmissionHandoff: { admissionId: "admission", materialHash: sha256("material") } },
  };
  const session = {
    binding,
    workspace,
    evidence,
    connectionFile,
    finished: new Promise(() => {}),
    close: async () => {
      state.closes++;
    },
  };
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname.replace("/api/v1", ""),
      body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ route, body, method: init.method });
    let value;
    if (state.override) value = await state.override(route, body);
    if (value === undefined) {
      if (route === "/llm/config")
        value = {
          activeProviderId: "comparison",
          activeModel: "fixture-model",
          providers: [
            {
              providerId: "comparison",
              baseUrl: state.unmetered ? "https://unmetered.invalid" : "http://127.0.0.1:9999/v1",
            },
          ],
        };
      else if (route === "/workspaces") value = { workspaceId: "workspace" };
      else if (route === "/chat/projects") value = { projectId: "project" };
      else if (route === "/chat/sessions") value = { sessionId: "session" };
      else if (route.endsWith("/route-preflight"))
        value = { decision: { effectiveProviderId: "comparison", effectiveModel: "fixture-model" } };
      else if (route.endsWith("/agent-send")) {
        await writeFile(path.join(workspace, "research.json"), JSON.stringify(answer));
        value = { turnId: "turn" };
      } else if (route.endsWith("/thread")) value = { sessionId: "session", turns: [turn] };
      else if (route === "/durable/runs/run") value = owner;
      else throw new Error(`Unexpected native route ${route}`);
    }
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  };
  const input = {
    session,
    manifest: { products: { goatcitadel: { revision } } },
    options: { cellId: binding.cellId },
    supervisor,
    fetchImpl,
    pollMs: 10,
  };
  return { ...input, input, root, state, requests, turn, owner, answer };
}

it("runs public web actions and retains native raw receipts without promoting controlled provenance", async (t) => {
  const f = await fixture(t),
    actions = await createAcceptanceActions(f.input);
  const { execution } = await runFeatureAcceptance({
    taskId: "web_research",
    session: f.session,
    actions,
    source: "controlled_fixture",
  });
  assert.equal(execution.source, "controlled_fixture");
  assert.ok(execution.nativeReceipts.some((ref) => ref.path === "native-permission-review.json"));
  assert.ok(execution.nativeReceipts.some((ref) => ref.path.startsWith("native-goat-acceptance-")));
  const proof = await verifyComparisonEvidence({
    taskId: "web_research",
    workspaceRoot: f.session.workspace,
    evidenceRoot: f.session.evidence,
  });
  assert.equal(proof.outcome, "passed");
  assert.equal(proof.evidenceKind, "controlled");
  assert.equal(f.state.stops, 1);
  assert.equal(f.state.closes, 1);
  const send = f.requests.find((request) => request.route.endsWith("/agent-send"));
  assert.equal(send.body.webMode, "deep");
  assert.equal(send.body.subagentPolicy, "off");
  const retained = await Promise.all(
    (await readdir(f.session.evidence)).map((name) => readFile(path.join(f.session.evidence, name), "utf8")),
  );
  assert.ok(retained.every((text) => !text.includes("g".repeat(40)) && !text.includes("short-lived-proxy-key")));
});

it("refuses unmetered configured providers and stops only its supervisor", async (t) => {
  const f = await fixture(t);
  f.state.unmetered = true;
  await assert.rejects(createAcceptanceActions(f.input), /metered proxy/u);
  assert.equal(f.state.stops, 1);
  assert.ok(!f.requests.some((request) => request.route === "/workspaces"));
});

it("refuses missing supervised lifecycle/review ports before native mutations", async (t) => {
  const f = await fixture(t);
  delete f.supervisor.reviewSources;
  await assert.rejects(createAcceptanceActions(f.input), /complete native journey/u);
  assert.equal(f.requests.length, 0);
});

it("refuses a changed runtime database on restart", async (t) => {
  const f = await fixture(t);
  const actions = await createAcceptanceActions(f.input);
  t.after(() => actions.close());
  await actions.run_turn();
  f.supervisor.restart = async () => ({
    runtimeId: "other-process",
    stateId: "wrong-db",
    revision,
    workspace: f.session.workspace,
    configurationSha256: sha256("config"),
    baseUrl: "http://127.0.0.1:8789/",
    token: "h".repeat(40),
  });
  await assert.rejects(actions.restart_owned_runtime(), /exact isolated state/u);
});

it("drives a real scheduled_due API shape and approves its linked delivery owner after restart", async (t) => {
  const f = await fixture(t, "scheduled_agent_work");
  f.state.scheduledFor = new Date(Date.now() + 60000).toISOString();
  f.turn.trace.toolRuns = [
    {
      toolName: "fs.read",
      status: "executed",
      args: { path: "input/ledger.json" },
      finishedAt: f.state.now,
      result: {
        path: path.join(f.session.workspace, "input", "ledger.json"),
        content: '{"amountsCents":[130,270,600]}',
      },
    },
  ];
  const approval = {
    approvalId: "approval",
    status: "pending",
    createdAt: f.state.now,
    linkage: { runId: "run", sessionId: "session", workspaceId: "workspace", toolName: "channel.send" },
  };
  const transport = {
    runId: "delivery-run",
    workflowKey: "connector.delivery",
    status: "completed",
    metadata: { sourceRunId: "run" },
    payload: {
      runId: "run",
      sessionId: "session",
      connectorId: "integration:connection",
      action: "channel.send",
      payload: { target: "123", message: '{"totalCents":1000}' },
    },
  };
  f.state.override = async (route, body) => {
    if (route === "/cron/jobs") return (f.state.job = { ...body, revision: 1, nextRunAt: f.state.scheduledFor });
    if (route.startsWith("/cron/jobs/")) return { ...f.state.job, activeRunId: "occurrence" };
    if (route === "/cron/runs/occurrence")
      return {
        canonical: {
          runId: "occurrence",
          jobId: f.state.job.jobId,
          jobRevision: 1,
          trigger: "scheduled_due",
          scheduledFor: f.state.scheduledFor,
          createdAt: f.state.now,
          childDurableRunId: "run",
          childSessionId: "session",
          childTurnId: "turn",
          deliveryRunId: "delivery-run",
          status: f.state.approved ? "completed" : "waiting",
        },
      };
    if (route === "/approvals") return { items: [approval] };
    if (route === "/approvals/approval/replay")
      return {
        approval,
        durableRunId: "approval-wait",
        pendingAction: {
          actionType: "tool.invoke",
          request: {
            toolName: "channel.send",
            runId: "run",
            sessionId: "session",
            args: { connectionId: "connection", target: "123", message: '{"totalCents":1000}' },
          },
        },
      };
    if (route === "/durable/runs/approval-wait")
      return {
        workflowKey: "approval.wait",
        payload: { approvalId: "approval" },
        status: "waiting",
        metadata: { waitForEvent: { eventKey: "approval.resolved", correlationId: "approval" } },
      };
    if (route === "/approvals/approval/resolve") {
      assert.deepEqual(body, { decision: "approve" });
      f.state.approved = true;
      return { ...approval, status: "approved" };
    }
    if (route === "/durable/runs/delivery-run") return transport;
    if (route === "/durable/runs/delivery-run/checkpoints")
      return {
        items: [
          {
            checkpointKind: "run_completed",
            runId: "delivery-run",
            state: {
              connectorId: "integration:connection",
              action: "channel.send",
              result: { deliveryId: "delivery" },
            },
          },
        ],
      };
    if (route === "/comms/deliveries")
      return {
        count: 1,
        deliveries: [
          {
            deliveryId: "delivery",
            connectionId: "connection",
            channelKey: "telegram",
            target: "123",
            status: "sent",
            deliveryStatus: "sent",
            attempts: 1,
            providerMessageId: "provider-message",
            updatedAt: new Date().toISOString(),
          },
        ],
      };
  };
  const actions = await createAcceptanceActions(f.input);
  t.after(() => actions.close());
  const admission = await actions.run_turn();
  assert.equal(admission.records[0].mode, "agent_turn");
  await actions.await_approval();
  await actions.restart_owned_runtime();
  await actions.operator_approve();
  const settled = await actions.await_settlement();
  assert.equal(settled.records[0].kind, "delivery_resumed");
  assert.equal(settled.records[0].deliveryRunId, "delivery-run");
  assert.equal(
    settled.records.find((record) => record.kind === "tool_result").resultSha256,
    sha256({ amountsCents: [130, 270, 600] }),
  );
  assert.ok(
    !f.requests.some(
      (request) =>
        request.method === "POST" && request.route.startsWith("/cron/jobs/") && request.route.endsWith("/run"),
    ),
  );
  const creator = f.requests.find((request) => request.route === "/cron/jobs").body.actionConfig.agentTurn.createdBy;
  assert.deepEqual(creator, { permissionProfileId: "trusted_local_power" });
  assert.ok(!f.requests.some((request) => request.route.endsWith("/resume")));
});

it("joins controlled pre-forward evidence to native failed/succeeded routes without claiming native non-dispatch", async (t) => {
  const f = await fixture(t, "provider_recovery");
  f.state.override = async (route) =>
    route.endsWith("/model-usage")
      ? {
          items: [
            {
              callKind: "chat_fallback",
              sessionId: "session",
              turnId: "turn",
              durableRunId: "run",
              effectiveProviderId: "comparison-fallback",
              terminalOutcome: "succeeded",
              startedAt: new Date(Date.parse(f.state.now) + 3).toISOString(),
              finishedAt: new Date(Date.parse(f.state.now) + 4).toISOString(),
            },
            {
              callKind: "chat_initial",
              sessionId: "session",
              turnId: "turn",
              durableRunId: "run",
              requestedProviderId: "comparison",
              terminalOutcome: "failed_before_usage",
              startedAt: f.state.now,
              finishedAt: new Date(Date.parse(f.state.now) + 2).toISOString(),
            },
          ],
        }
      : undefined;
  const actions = await createAcceptanceActions(f.input);
  t.after(() => actions.close());
  await actions.arm_predispatch_failure();
  const result = await actions.run_turn();
  assert.equal(result.records[0].outcome, "controlled_pre_forward_failure");
  assert.equal(result.records[0].nativeTransportReachedFixture, true);
  assert.equal(result.records[2].surface, "chat");
  assert.equal(
    f.requests.find((request) => request.route.endsWith("/agent-send")).body.providerFallback.providerId,
    "comparison-fallback",
  );
  f.state.override = async (route) => (route.endsWith("/model-usage") ? { items: [] } : undefined);
  await assert.rejects(actions.run_turn(), /does not prove/u);
  const toolName = "mcp.marker-server.record_marker",
    args = { marker: "controlled-marker" };
  f.supervisor.armUncertainEffect = async ({ runtimeId }) => ({
    runtimeId,
    toolName,
    argsSha256: sha256(args),
    mcpServerIds: ["marker-server"],
    prompt: `Call ${toolName} once; stop for reconciliation if its response is lost.`,
  });
  const uncertainTurn = {
    turnId: "uncertain-turn",
    trace: {
      sessionId: "uncertain-session",
      turnId: "uncertain-turn",
      durable: { runId: "uncertain-run" },
      status: "waiting",
      startedAt: f.state.now,
      toolRuns: [],
    },
  };
  f.state.override = async (route, body) => {
    if (route === "/chat/sessions") return { sessionId: "uncertain-session" };
    if (route.endsWith("/agent-send")) return { turnId: "uncertain-turn" };
    if (route.endsWith("/thread")) return { sessionId: "uncertain-session", turns: [uncertainTurn] };
    if (route === "/approvals")
      return {
        items: [
          {
            approvalId: "marker-approval",
            status: "pending",
            linkage: { sessionId: "uncertain-session", turnId: "uncertain-turn", runId: "uncertain-run", toolName },
          },
        ],
      };
    if (route === "/approvals/marker-approval/resolve") {
      assert.deepEqual(body, { decision: "approve" });
      uncertainTurn.trace.toolRuns = [
        {
          toolRunId: "uncertain-effect",
          toolName,
          args,
          effectDisposition: "unknown",
          effectOutcomeKind: "uncertain",
          finishedAt: new Date().toISOString(),
        },
      ];
      return { status: "approved" };
    }
    if (route === "/durable/runs/uncertain-run")
      return {
        ...f.owner,
        runId: "uncertain-run",
        status: "waiting",
        payload: { workspaceId: "workspace", sessionId: "uncertain-session", turnId: "uncertain-turn" },
      };
  };
  f.supervisor.observeEffectTransport = async (input) => ({
    ...input,
    automaticRetries: 0,
    dispatches: [{ transportReceiptId: "retained-marker", outcome: "unknown_after_send" }],
  });
  const uncertain = await actions.run_uncertain_effect_case();
  assert.equal(uncertain.records[0].effectId, "uncertain-effect");
  const reconciled = await actions.read_reconciliation();
  assert.equal(reconciled.records[0].dispatchCount, 1);
  assert.equal(f.requests.filter((request) => request.route === "/approvals/marker-approval/resolve").length, 1);
  const markerSend = f.requests.filter((request) => request.route.endsWith("/agent-send")).at(-1);
  assert.equal(markerSend.body.providerFallback, undefined);
  assert.equal(markerSend.body.enabledMcpServerIds, undefined);
});

it("retains the public fanout projection and original child identities across an owned restart", async (t) => {
  const f = await fixture(t, "delegation");
  const childSteps = () =>
    ["north", "south"].map((region, index) => ({
      stepId: region,
      runId: "delegation",
      index,
      status: index === 0 || f.state.runtime > 1 ? "completed" : "running",
      childSessionId: `session-${region}`,
      childTurnId: `turn-${region}`,
      durableRunId: `run-${region}`,
      finishedAt: f.state.now,
      output: JSON.stringify({ region, totalCents: index ? 600 : 400 }),
    }));
  f.turn.trace.toolRuns = [
    {
      toolName: "agent.fanout",
      toolRunId: "fanout-tool",
      status: "executed",
      result: { delegationRunId: "delegation", parentRunId: "run", toolRunId: "fanout-tool" },
    },
  ];
  f.state.override = async (route) => {
    if (route.endsWith("/agent-send")) {
      await writeFile(
        path.join(f.session.workspace, "delegation.json"),
        JSON.stringify({ northCents: 400, southCents: 600, totalCents: 1000 }),
      );
      return { turnId: "turn" };
    }
    if (route.endsWith("/delegations/delegation"))
      return {
        run: { runId: "delegation", parentRunId: "run", sessionId: "session", startedAt: f.state.now },
        steps: childSteps(),
      };
    const child = ["north", "south"].find(
      (region) => route.includes(`session-${region}`) || route.endsWith(`run-${region}`),
    );
    if (child && route.endsWith("/thread"))
      return {
        sessionId: `session-${child}`,
        turns: [
          {
            turnId: `turn-${child}`,
            trace: {
              turnId: `turn-${child}`,
              sessionId: `session-${child}`,
              durable: { runId: `run-${child}` },
              status: "completed",
              routing: { executionBudget: { maxToolLoops: 2, maxTokens: 4096 } },
            },
          },
        ],
      };
    if (child && route.startsWith("/durable/runs/"))
      return { status: "completed", payload: { sessionId: `session-${child}`, turnId: `turn-${child}` } };
    if (route.endsWith("/model-usage")) {
      const lastRequest = f.requests.at(-1);
      // The actual query is inspected separately by the transport callback below.
      return {
        items: [
          {
            sessionId: lastRequest.sessionId,
            turnId: lastRequest.turnId,
            durableRunId: lastRequest.runId,
            inputTokens: 50,
            outputTokens: 20,
          },
        ],
      };
    }
  };
  const fetchImpl = f.input.fetchImpl;
  f.input.fetchImpl = async (url, init) => {
    if (new URL(url).pathname.endsWith("/model-usage")) {
      const query = new URL(url).searchParams;
      return new Response(
        JSON.stringify({
          items: [
            {
              sessionId: query.get("sessionId"),
              turnId: query.get("turnId"),
              durableRunId: query.get("durableRunId"),
              inputTokens: 50,
              outputTokens: 20,
            },
          ],
        }),
      );
    }
    return fetchImpl(url, init);
  };
  const actions = await createAcceptanceActions(f.input);
  await runFeatureAcceptance({ taskId: "delegation", session: f.session, actions, source: "controlled_fixture" });
  const verified = await verifyComparisonEvidence({
    taskId: "delegation",
    workspaceRoot: f.session.workspace,
    evidenceRoot: f.session.evidence,
  });
  assert.equal(verified.outcome, "passed");
  assert.equal(verified.evidenceKind, "controlled");
  assert.equal(
    f.requests.find((request) => request.route.endsWith("/agent-send")).body.subagentPolicy,
    "auto_when_useful",
  );
  assert.equal(f.requests.filter((request) => request.route.endsWith("/agent-send")).length, 1);
  assert.equal(f.state.stops, 1);
});
