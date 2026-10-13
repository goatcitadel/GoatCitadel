import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createGoatComparisonClient } from "./agent-comparison-goat-client.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { sha256 } from "./agent-comparison.mjs";
import { FEATURE_ACCEPTANCE_TASKS } from "./agent-comparison-acceptance-fixtures.mjs";
import {
  normalizeComparisonPermissions,
  PERMISSION_REVIEW_VERSION,
  PERMISSION_REVIEW_FILE,
} from "./agent-comparison-permissions.mjs";

export const product = "goatcitadel";
// Re-review this adapter against native API/receipt changes before changing this pin.
export const revision = "997e682752d939b415ee71523794197a37d4d4d3";
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
const routeId = (value) => {
  check(identifier(value) && ![".", ".."].includes(value), "Missing exact native resource identity.");
  return encodeURIComponent(value);
};
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const equal = (left, right) => sha256(left) === sha256(right);
const complete = (value) => value === "completed";

/** Real public Gateway actions; never uses internal services, SQL, or fabricated
 * capability profiles. The separately reviewed supervisor owns ONLY its isolated
 * process, explicit operator decisions, and fault/transport observation ports.
 * Missing native receipts are an incomplete run, not inferred success. */
export async function createAcceptanceActions({
  session,
  manifest,
  options,
  supervisor,
  fetchImpl = fetch,
  pollMs = 1000,
}) {
  const taskId = options.cellId.split(":")[1];
  const task = FEATURE_ACCEPTANCE_TASKS.find((entry) => entry.id === taskId);
  check(
    task && manifest.products.goatcitadel?.revision === revision && session.binding.revision === revision,
    "The Goat acceptance adapter requires its exact reviewed source pin.",
  );
  check(
    supervisor &&
      typeof supervisor.start === "function" &&
      typeof supervisor.stop === "function" &&
      typeof supervisor.reviewPermissions === "function",
    "Attach a hash-reviewed supervisor for an isolated runtime; ambient Gateways are unsupported.",
  );
  check(Number.isInteger(pollMs) && pollMs >= 10 && pollMs <= 10000, "Use bounded native polling.");
  const required =
    taskId === "web_research"
      ? ["reviewSources"]
      : taskId === "scheduled_agent_work"
        ? ["restart", "approve", "authorizeSchedule"]
        : taskId === "provider_recovery"
          ? ["armPreDispatchFailure", "observeProviderFault", "armUncertainEffect", "observeEffectTransport", "approve"]
          : ["restart"];
  check(
    required.every((name) => typeof supervisor[name] === "function"),
    "The supervisor cannot perform this complete native journey.",
  );
  const connection = await readComparisonJson(session.connectionFile);
  const abort = new AbortController();
  void session.finished.then(
    () => abort.abort(new Error("Comparison session closed.")),
    () => abort.abort(),
  );
  let runtime,
    api,
    scope,
    turn,
    occurrence,
    job,
    approval,
    restarted,
    delegation,
    uncertain,
    sequence = 0,
    eventSequence = 0,
    retainedBytes = 0,
    closing;
  const receipts = [],
    secrets = new Set([connection.apiKey]);
  const save = async (name, value) => {
    const filename = `native-goat-acceptance-${String(++sequence).padStart(4, "0")}.json`;
    check(sequence <= 500, "Native receipt inventory exceeded its bound.");
    let serialized = JSON.stringify({ name, observedAt: new Date().toISOString(), ...value }, null, 2) + "\n";
    for (const secret of secrets) if (secret) serialized = serialized.replaceAll(secret, "[credential]");
    check(Buffer.byteLength(serialized) <= 4 * 1024 * 1024, "Native receipt exceeds its bound.");
    retainedBytes += Buffer.byteLength(serialized);
    check(retainedBytes <= 40 * 1024 * 1024, "Native acceptance exceeded its aggregate evidence bound.");
    const file = await open(path.join(session.evidence, filename), "wx", 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    receipts.push({ path: filename, sha256: sha256(Buffer.from(serialized)) });
  };
  const event = (kind, material, at = new Date().toISOString()) => {
    check(timestamp(at), "A native record has no timestamp.");
    return { kind, id: `goat-${++eventSequence}`, at, ...material };
  };
  const result = (records) => ({ records, nativeReceipts: receipts.splice(0) });
  const signal = () => abort.signal;
  const poll = async (read) => {
    for (;;) {
      signal().throwIfAborted();
      const value = await read();
      if (value) return value;
      await delay(pollMs, undefined, { signal: signal() });
    }
  };
  const attach = async (next, previous) => {
    check(
      next &&
        identifier(next.runtimeId) &&
        identifier(next.stateId) &&
        next.revision === revision &&
        path.resolve(next.workspace ?? "") === path.resolve(session.workspace) &&
        /^[a-f0-9]{64}$/u.test(next.configurationSha256 ?? ""),
      "The supervisor did not bind the isolated source, workspace and configuration.",
    );
    if (previous)
      check(
        next.runtimeId !== previous.runtimeId &&
          next.stateId === previous.stateId &&
          next.configurationSha256 === previous.configurationSha256,
        "Restart must retain the exact isolated state/configuration and replace only its owned process.",
      );
    secrets.add(next.token);
    api = createGoatComparisonClient({
      baseUrl: next.baseUrl,
      token: next.token,
      retain: save,
      signal: signal(),
      fetchImpl,
    });
    const config = await api("llm-config", "/llm/config");
    check(
      Array.isArray(config.providers) &&
        config.providers.length > 0 &&
        config.providers.every(
          (provider) => provider.baseUrl?.replace(/\/$/u, "") === connection.baseUrl.replace(/\/$/u, ""),
        ),
      "Every configured model route must use this cell's metered proxy, including fallback and auxiliary work.",
    );
    check(
      config.activeProviderId === "comparison" && config.activeModel === connection.model,
      "The native default provider/model differs from the metered cell.",
    );
    runtime = next;
    await save("runtime-attached", {
      runtimeId: next.runtimeId,
      stateId: next.stateId,
      revision,
      configurationSha256: next.configurationSha256,
    });
  };
  const createScope = async () => {
    const workspace = await api("workspace-create", "/workspaces", {
      name: "Feature acceptance",
      slug: "feature-acceptance",
    });
    const project = await api("project-create", "/chat/projects", {
      workspaceId: workspace.workspaceId,
      name: "Feature acceptance",
      workspacePath: ".",
    });
    const chat = await api("session-create", "/chat/sessions", {
      workspaceId: workspace.workspaceId,
      projectId: project.projectId,
      title: taskId,
      mode: "chat",
    });
    scope = { workspaceId: workspace.workspaceId, projectId: project.projectId, sessionId: chat.sessionId };
    check(Object.values(scope).every(identifier), "Native Chat scope was not created.");
  };
  const readTurn = async (selected = turn) => {
    const thread = await api("thread", `/chat/sessions/${routeId(scope.sessionId)}/thread`);
    check(thread.sessionId === scope.sessionId && Array.isArray(thread.turns), "Native thread scope changed.");
    const found = selected ? thread.turns.find((entry) => entry.turnId === selected.turnId) : thread.turns.at(-1);
    if (!found) return undefined;
    check(
      found.trace?.sessionId === scope.sessionId &&
        found.trace.turnId === found.turnId &&
        identifier(found.trace.durable?.runId),
      "Native turn has no exact durable lineage.",
    );
    if (selected)
      check(found.trace.durable.runId === selected.trace.durable.runId, "Native durable turn identity changed.");
    return found;
  };
  const durable = async (selected = turn) => {
    const run = await api("chat-durable", `/durable/runs/${routeId(selected.trace.durable.runId)}`);
    check(
      run.runId === selected.trace.durable.runId &&
        run.workflowKey === "chat.turn.execute" &&
        run.payload?.sessionId === scope.sessionId &&
        run.payload.turnId === selected.turnId,
      "Native durable execution changed Chat scope.",
    );
    return run;
  };
  const turnScope = (selected = turn) => ({ runId: selected.trace.durable.runId, turnId: selected.turnId });
  const send = async (content, overrides = {}, wait = true) => {
    const input = {
      content,
      providerId: "comparison",
      model: connection.model,
      webMode: taskId === "web_research" ? "deep" : "off",
      memoryMode: "off",
      useMemory: false,
      subagentPolicy: taskId === "delegation" ? "auto_when_useful" : "off",
      ...overrides,
    };
    const preflight = await api("route-preflight", `/chat/sessions/${routeId(scope.sessionId)}/route-preflight`, {
      action: "send",
      ...input,
    });
    check(
      preflight.decision?.effectiveProviderId === input.providerId && preflight.decision.effectiveModel === input.model,
      "Native route preflight changed the pinned provider/model.",
    );
    // Never retry this mutation after a lost response. The durable thread is the
    // recovery owner; a restart may legitimately close the original HTTP call.
    const sent = api("agent-send", `/chat/sessions/${routeId(scope.sessionId)}/agent-send`, {
      ...input,
      routeDecision: preflight.decision,
    });
    let sendFailure;
    void sent.catch((error) => {
      sendFailure = error;
    });
    if (wait) await sent;
    turn = await poll(async () => {
      const found = await readTurn(undefined);
      if (!found && sendFailure) throw sendFailure;
      return found;
    });
    return turn;
  };
  const settle = async () =>
    poll(async () => {
      const current = await readTurn();
      const run = await durable(current);
      if (["failed", "cancelled", "dead_lettered"].includes(run.status))
        throw new Error("Native durable execution failed; retain its receipts.");
      if (complete(current.trace.status) && complete(run.status)) {
        turn = current;
        return run;
      }
    });
  const artifact = async (name) => {
    check(/^[a-z]+\.json$/u.test(name), "Use a fixture artifact name.");
    const filename = path.join(session.workspace, name),
      info = await lstat(filename);
    check(
      info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (await realpath(filename)) === filename,
      "The model artifact escaped the ordinary cell workspace.",
    );
    return readComparisonJson(filename);
  };
  const usage = async (selected = turn) => {
    const rows = await api(
      "usage",
      `/ops/workspaces/${routeId(scope.workspaceId)}/model-usage?sessionId=${routeId(selected.trace.sessionId)}&turnId=${routeId(selected.turnId)}&durableRunId=${routeId(selected.trace.durable.runId)}&limit=200`,
    );
    check(
      Array.isArray(rows.items) &&
        !rows.nextCursor &&
        rows.items.length < 200 &&
        rows.items.every(
          (item) =>
            item.sessionId === selected.trace.sessionId &&
            item.turnId === selected.turnId &&
            item.durableRunId === selected.trace.durable.runId,
        ),
      "Native usage inventory is incomplete or changed scope.",
    );
    return rows.items;
  };
  const readDelegation = async () => {
    const current = await readTurn();
    const fanout = current.trace.toolRuns.find(
      (tool) => tool.toolName === "agent.fanout" && tool.result?.delegationRunId,
    );
    if (fanout)
      check(
        fanout.result.parentRunId === current.trace.durable.runId && fanout.result.toolRunId === fanout.toolRunId,
        "The fanout tool projection changed its parent or tool owner.",
      );
    const runId = current.trace.orchestration?.runId ?? fanout?.result.delegationRunId;
    if (!runId) return undefined;
    const value = await api("delegation", `/chat/sessions/${routeId(scope.sessionId)}/delegations/${routeId(runId)}`);
    check(
      value.run?.runId === runId &&
        value.run.sessionId === scope.sessionId &&
        value.run.parentRunId === current.trace.durable.runId &&
        Array.isArray(value.steps) &&
        value.steps.length === 2 &&
        value.steps.every((step) => step.runId === runId && identifier(step.stepId)) &&
        new Set(value.steps.map((step) => step.stepId)).size === 2,
      "The native delegation is not the exact two-child plan.",
    );
    if (delegation)
      check(
        equal(
          value.steps.map((step) => step.stepId),
          delegation.steps.map((step) => step.stepId),
        ),
        "Native delegation spawned replacement children.",
      );
    return value;
  };
  const readChild = async (step) => {
    check(
      complete(step.status) && [step.childSessionId, step.childTurnId, step.durableRunId].every(identifier),
      "Native child lineage is incomplete.",
    );
    const thread = await api("child-thread", `/chat/sessions/${routeId(step.childSessionId)}/thread`);
    const child = thread.turns?.find((entry) => entry.turnId === step.childTurnId);
    check(
      thread.sessionId === step.childSessionId &&
        child?.trace?.durable?.runId === step.durableRunId &&
        complete(child.trace.status),
      "Native child turn does not match the delegation step.",
    );
    const owner = await api("child-durable", `/durable/runs/${routeId(step.durableRunId)}`);
    check(
      complete(owner.status) &&
        owner.payload?.sessionId === step.childSessionId &&
        owner.payload.turnId === step.childTurnId,
      "Native child durable owner did not settle.",
    );
    const events = await usage(child),
      budget = child.trace.routing?.executionBudget;
    check(
      Number.isInteger(budget?.maxToolLoops) &&
        budget.maxToolLoops >= 0 &&
        Number.isInteger(budget.maxTokens) &&
        budget.maxTokens > 0 &&
        events.length > 0 &&
        events.every((item) => Number.isInteger(item.inputTokens) && Number.isInteger(item.outputTokens)),
      "Native child usage or declared execution budget is unavailable.",
    );
    // The result must be the child's actual structured output, never inferred
    // from the expected fixture or the parent's synthesis.
    const output = typeof step.output === "string" ? JSON.parse(step.output) : step.output;
    check(
      output && ["north", "south"].includes(output.region) && Number.isInteger(output.totalCents),
      "Native child did not retain the required structured result.",
    );
    return event(
      "child_result",
      {
        runId: delegation.run.runId,
        childId: step.stepId,
        result: output,
        resultSha256: sha256(output),
        maxRequests: budget.maxToolLoops + 1,
        requests: events.length,
        maxTokens: budget.maxTokens * (budget.maxToolLoops + 1),
        tokens: events.reduce((sum, item) => sum + item.outputTokens, 0),
      },
      step.finishedAt,
    );
  };
  let firstChild, approvedAt, authorization;
  const scheduled = async () => {
    const currentJob = await api("cron-job", `/cron/jobs/${routeId(job.jobId)}`);
    check(
      currentJob.revision === job.revision && equal(currentJob.actionConfig, job.actionConfig),
      "The reviewed native schedule changed.",
    );
    const runId = currentJob.activeRunId ?? currentJob.lastRunId;
    if (!runId) return undefined;
    const observed = await api("cron-run", `/cron/runs/${routeId(runId)}`),
      value = observed.canonical;
    check(
      value?.runId === runId &&
        value.jobId === job.jobId &&
        value.jobRevision === job.revision &&
        value.trigger === "scheduled_due" &&
        value.scheduledFor === authorization.scheduledFor &&
        (!occurrence || value.runId === occurrence.runId),
      "The native occurrence is manual, changed, or outside the authorized scheduled time.",
    );
    return value;
  };
  const pending = async (toolName = "channel.send") => {
    const page = await api(
      "approvals",
      `/approvals?status=pending&limit=200&workspaceId=${routeId(scope.workspaceId)}`,
    );
    check(Array.isArray(page.items) && !page.nextCursor, "Native approval inventory is incomplete.");
    const matches = page.items.filter(
      (item) =>
        item.status === "pending" &&
        item.linkage?.sessionId === scope.sessionId &&
        (item.linkage.turnId === undefined || item.linkage.turnId === turn.turnId) &&
        item.linkage.runId === turn.trace.durable.runId &&
        item.linkage.toolName === toolName,
    );
    check(matches.length <= 1, "The scheduled case has ambiguous approvals.");
    return matches[0];
  };
  const delivery = async () => {
    const value = await scheduled();
    if (!complete(value?.status)) return undefined;
    check(
      value.deliveryRunId && value.childDurableRunId === turn.trace.durable.runId && value.childTurnId === turn.turnId,
      "The scheduled occurrence lost its child or delivery owner.",
    );
    const transport = await api("delivery-durable", `/durable/runs/${routeId(value.deliveryRunId)}`);
    check(
      transport.workflowKey === "connector.delivery" &&
        complete(transport.status) &&
        transport.metadata?.sourceRunId === turn.trace.durable.runId &&
        transport.payload?.runId === turn.trace.durable.runId &&
        transport.payload.sessionId === scope.sessionId &&
        transport.payload.connectorId === `integration:${authorization.connectionId}` &&
        transport.payload.action === "channel.send" &&
        transport.payload.payload?.target === authorization.target,
      "Native delivery is not bound to this scheduled Chat child and destination.",
    );
    const message = JSON.parse(transport.payload.payload.message);
    check(message.totalCents === 1000, "The delivered report does not contain the computed total.");
    const checkpoints = await api(
      "delivery-checkpoints",
      `/durable/runs/${routeId(value.deliveryRunId)}/checkpoints?limit=200`,
    );
    check(Array.isArray(checkpoints.items) && checkpoints.items.length < 200, "Delivery checkpoints are incomplete.");
    const finished = checkpoints.items.filter((item) => item.checkpointKind === "run_completed");
    check(
      finished.length === 1 &&
        finished[0].runId === value.deliveryRunId &&
        finished[0].state?.connectorId === transport.payload.connectorId &&
        finished[0].state.action === "channel.send",
      "Missing exact delivery completion checkpoint.",
    );
    const page = await api("deliveries", "/comms/deliveries?limit=200");
    check(
      page.count === 1 && page.deliveries?.length === 1,
      "The isolated runtime has duplicate or ambiguous deliveries.",
    );
    const row = page.deliveries[0];
    check(
      row.deliveryId === finished[0].state.result?.deliveryId &&
        row.connectionId === authorization.connectionId &&
        row.channelKey === authorization.channelKey &&
        row.target === authorization.target &&
        row.status === "sent" &&
        row.deliveryStatus === "sent" &&
        row.attempts === 1 &&
        identifier(row.providerMessageId),
      "The delivery lacks one acknowledged provider receipt.",
    );
    return row;
  };
  const actions = {
    async run_turn() {
      if (taskId === "scheduled_agent_work") {
        authorization = await supervisor.authorizeSchedule({ task, signal: signal() });
        check(
          authorization?.actorKind === "human" &&
            identifier(authorization.actorId) &&
            identifier(authorization.channelKey) &&
            identifier(authorization.connectionId) &&
            /^-?[0-9]{1,30}$/u.test(authorization.target ?? "") &&
            timestamp(authorization.scheduledFor) &&
            Date.parse(authorization.scheduledFor) > Date.now() &&
            Date.parse(authorization.scheduledFor) < Date.now() + 300000 &&
            typeof authorization.schedule === "string",
          "Review one bounded future schedule and exact test destination.",
        );
        await save("schedule-authorization", { authorization });
        job = await api("cron-create", "/cron/jobs", {
          jobId: `acceptance-${Date.now()}`,
          name: "Feature acceptance tool work",
          action: "agent_turn",
          enabled: true,
          schedule: authorization.schedule,
          endAt: new Date(Date.parse(authorization.scheduledFor) + 30000).toISOString(),
          actionConfig: {
            agentTurn: {
              prompt:
                'Read input/ledger.json with fs.read. Sum all amountsCents. Reply with only JSON {"totalCents":number}. This report goes to the already authorized delivery destination after normal approval.',
              sessionId: scope.sessionId,
              createdBy: { permissionProfileId: "trusted_local_power" },
              deliveryChannel: {
                channelKey: authorization.channelKey,
                target: authorization.target,
                connectionId: authorization.connectionId,
              },
              deliverMode: "always",
            },
          },
        });
        check(
          job.nextRunAt === authorization.scheduledFor &&
            job.action === "agent_turn" &&
            !job.lastRunId &&
            !job.activeRunId,
          "Native scheduler did not retain the reviewed future occurrence.",
        );
        occurrence = await poll(async () => {
          const value = await scheduled();
          return value?.childDurableRunId && value.childTurnId ? value : undefined;
        });
        turn = await poll(() => readTurn(undefined));
        check(
          turn.turnId === occurrence.childTurnId &&
            turn.trace.durable.runId === occurrence.childDurableRunId &&
            occurrence.childSessionId === scope.sessionId,
          "Scheduled work did not admit the exact canonical Chat child.",
        );
        return result([
          event(
            "scheduled_occurrence",
            {
              occurrenceId: occurrence.runId,
              ...turnScope(),
              mode: "agent_turn",
              authorizedDestination: `${authorization.channelKey}:${authorization.target}`,
            },
            occurrence.createdAt,
          ),
          event("turn_admitted", { occurrenceId: occurrence.runId, ...turnScope() }, turn.trace.startedAt),
        ]);
      }
      await send(
        task.prompt,
        taskId === "provider_recovery"
          ? {
              providerFallback: {
                providerId: "comparison-fallback",
                model: connection.model,
                allowLocalToCloud: false,
              },
            }
          : {},
        taskId !== "delegation",
      );
      if (taskId === "delegation") {
        delegation = await poll(readDelegation);
        return result([
          event(
            "delegation_plan",
            { runId: delegation.run.runId, childIds: delegation.steps.map((step) => step.stepId), surface: "chat" },
            delegation.run.startedAt,
          ),
        ]);
      }
      await settle();
      if (taskId === "web_research")
        return result(
          turn.trace.toolRuns
            .filter((tool) => tool.status === "executed")
            .flatMap((tool) => {
              if (tool.toolName === "browser.search")
                return [
                  event(
                    "web_search",
                    { query: tool.args?.query, resultUrls: tool.result?.results?.map((entry) => entry.url) },
                    tool.finishedAt,
                  ),
                ];
              if (tool.toolName === "browser.extract" && typeof tool.result?.text === "string")
                return [
                  event(
                    "web_source",
                    {
                      url: tool.args?.url,
                      status: tool.result.status,
                      text: tool.result.text,
                      contentSha256: sha256(tool.result.text),
                    },
                    tool.finishedAt,
                  ),
                ];
              return [];
            }),
        );
      const allUsage = await usage();
      const events = allUsage
        .filter((item) => ["chat_initial", "chat_fallback"].includes(item.callKind))
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
      check(
        events.length === 2 &&
          events[0].callKind === "chat_initial" &&
          events[0].terminalOutcome === "failed_before_usage" &&
          events[1].callKind === "chat_fallback" &&
          events[1].terminalOutcome === "succeeded",
        "Native usage does not prove one failed initial attempt and one successful fallback.",
      );
      const observed = await supervisor.observeProviderFault({ runtimeId: runtime.runtimeId, signal: signal() });
      check(
        observed?.runtimeId === runtime.runtimeId &&
          observed.cellId === options.cellId &&
          observed.controlled === true &&
          observed.boundary === "before_upstream_forward" &&
          observed.nativeTransportReachedFixture === true &&
          observed.upstreamForwarded === false &&
          observed.status === 503 &&
          observed.usefulOutputBytes === 0 &&
          identifier(observed.transportReceiptId) &&
          /^[a-f0-9]{64}$/u.test(observed.requestSha256 ?? "") &&
          Number.isSafeInteger(observed.budgetSequence) &&
          Date.parse(observed.startedAt) >= Date.parse(events[0].startedAt) &&
          Date.parse(observed.finishedAt) <= Date.parse(events[0].finishedAt) &&
          Date.parse(events[0].finishedAt) <= Date.parse(events[1].startedAt) &&
          !allUsage.some((item) => item !== events[0] && Date.parse(item.startedAt) < Date.parse(events[1].startedAt)),
        "The controlled transport fault does not bind the initial native call before fallback; an auxiliary call may have consumed it.",
      );
      await save("controlled-provider-fault", { observed, nativeInitialEventId: events[0].eventId });
      const routing = turn.trace.routing;
      const firstProviderId = events[0].effectiveProviderId ?? events[0].requestedProviderId;
      check(
        routing?.fallbackUsed === true &&
          routing.primaryProviderId === firstProviderId &&
          routing.effectiveProviderId === events[1].effectiveProviderId,
        "The Chat trace does not disclose the actual fallback route.",
      );
      return result([
        ...events.map((item, index) =>
          event(
            "provider_attempt",
            {
              ...turnScope(),
              providerId: index ? item.effectiveProviderId : firstProviderId,
              outcome: index ? "completed" : "controlled_pre_forward_failure",
              ...(!index
                ? {
                    controlled: true,
                    nativeTransportReachedFixture: true,
                    upstreamForwarded: false,
                    usefulOutputBytes: 0,
                    transportReceiptId: observed.transportReceiptId,
                    transportReceiptSha256: sha256(observed),
                  }
                : {}),
            },
            item.finishedAt ?? item.startedAt,
          ),
        ),
        event("provider_changed", {
          ...turnScope(),
          fromProviderId: routing.primaryProviderId,
          toProviderId: routing.effectiveProviderId,
          surface: "chat",
          routeReferenceSha256: sha256(routing),
        }),
      ]);
    },
    async review_sources() {
      const answer = await artifact("research.json");
      const review = await supervisor.reviewSources({
        artifact: answer,
        artifactSha256: sha256(answer),
        tools: turn.trace.toolRuns,
        signal: signal(),
      });
      check(
        review?.reviewerKind === "human" && identifier(review.reviewerId) && review.artifactSha256 === sha256(answer),
        "Source review must be a human decision on this exact artifact.",
      );
      await save("source-review", { review });
      return result([event("source_review", review)]);
    },
    async await_approval() {
      approval = await poll(pending);
      return result([
        event("approval_pending", { ...turnScope(), approvalId: approval.approvalId }, approval.createdAt),
      ]);
    },
    async restart_owned_runtime() {
      const previous = runtime;
      await attach(
        await supervisor.restart({ runtimeId: runtime.runtimeId, stateId: runtime.stateId, signal: signal() }),
        previous,
      );
      restarted = event("runtime_restart", { previousRuntimeId: previous.runtimeId, runtimeId: runtime.runtimeId });
      await readTurn();
      return result([restarted]);
    },
    async operator_approve() {
      const replay = await api("approval-replay", `/approvals/${routeId(approval.approvalId)}/replay`);
      check(
        replay.approval?.approvalId === approval.approvalId &&
          replay.approval.status === "pending" &&
          equal(replay.approval.linkage, approval.linkage) &&
          identifier(replay.durableRunId),
        "Approval changed or was already resolved after restart.",
      );
      const wait = await api("approval-wait", `/durable/runs/${routeId(replay.durableRunId)}`),
        owner = await durable();
      check(
        wait.workflowKey === "approval.wait" &&
          wait.payload?.approvalId === approval.approvalId &&
          wait.status === "waiting" &&
          wait.metadata?.waitForEvent?.eventKey === "approval.resolved" &&
          wait.metadata.waitForEvent.correlationId === approval.approvalId,
        "The canonical approval owner is not waiting for this exact decision.",
      );
      occurrence = await scheduled();
      const deliveryOwner = await api("delivery-approval-owner", `/durable/runs/${routeId(occurrence.deliveryRunId)}`);
      const request = replay.pendingAction?.request;
      check(
        complete(owner.status) &&
          deliveryOwner.workflowKey === "connector.delivery" &&
          complete(deliveryOwner.status) &&
          deliveryOwner.metadata?.sourceRunId === owner.runId &&
          deliveryOwner.payload?.runId === owner.runId &&
          deliveryOwner.payload.sessionId === scope.sessionId &&
          deliveryOwner.payload.connectorId === `integration:${authorization.connectionId}` &&
          replay.pendingAction?.actionType === "tool.invoke" &&
          request?.toolName === "channel.send" &&
          request.runId === owner.runId &&
          request.sessionId === scope.sessionId &&
          request.args?.connectionId === authorization.connectionId &&
          request.args.target === authorization.target &&
          request.args.message === deliveryOwner.payload.payload?.message,
        "The approval is not the exact queued delivery action of this completed scheduled Chat child.",
      );
      const decision = await supervisor.approve({ approval: replay.approval, signal: signal() });
      check(
        decision?.actorKind === "human" &&
          identifier(decision.actorId) &&
          decision.decision === "approve" &&
          decision.approvalId === approval.approvalId,
        "An explicit human approval for this exact action is required.",
      );
      await save("approval-operator-decision", { decision });
      const resolved = await api("approval-resolve", `/approvals/${routeId(approval.approvalId)}/resolve`, {
        decision: "approve",
      });
      check((resolved.approval ?? resolved).status === "approved", "Native approval did not persist its decision.");
      approvedAt = new Date().toISOString();
      return result([
        event(
          "approval",
          {
            ...turnScope(),
            approvalId: approval.approvalId,
            decision: "approved",
            actorKind: "human",
            actorId: decision.actorId,
          },
          approvedAt,
        ),
      ]);
    },
    async await_settlement() {
      const owner = await settle();
      if (taskId === "delegation") {
        delegation = await readDelegation();
        check(
          delegation.steps.every((step) => complete(step.status)),
          "Delegation did not settle both original children.",
        );
        return result([
          event("delegation_recovered", {
            runId: delegation.run.runId,
            childIds: delegation.steps.map((step) => step.stepId),
            spawnedChildren: delegation.steps.length,
          }),
        ]);
      }
      check(owner.metadata?.chatTurnAdmissionHandoff, "Current canonical Chat admission evidence is unavailable.");
      const tools = turn.trace.toolRuns.filter((tool) => tool.status === "executed" && tool.toolName === "fs.read");
      for (const tool of tools)
        check(
          path.resolve(tool.result?.path ?? "") === path.join(session.workspace, "input", "ledger.json"),
          "The scheduled read did not access this cell's exact ledger fixture.",
        );
      const row = await poll(delivery);
      return result([
        event(
          "delivery_resumed",
          {
            ...turnScope(),
            approvalId: approval.approvalId,
            runtimeId: runtime.runtimeId,
            deliveryRunId: occurrence.deliveryRunId,
          },
          row.updatedAt,
        ),
        ...tools.map((tool) =>
          event(
            "tool_result",
            {
              ...turnScope(),
              toolName: tool.toolName,
              status: "completed",
              path: "input/ledger.json",
              authoritySha256: sha256(owner.metadata.chatTurnAdmissionHandoff),
              resultSha256: sha256(JSON.parse(tool.result?.content)),
            },
            tool.finishedAt,
          ),
        ),
        event(
          "delivery_receipt",
          {
            ...turnScope(),
            totalCents: 1000,
            providerMessageId: row.providerMessageId,
            destination: `${row.channelKey}:${row.target}`,
          },
          row.updatedAt,
        ),
      ]);
    },
    async reconnect() {
      const before = await delivery(),
        previous = runtime;
      await attach(
        await supervisor.restart({ runtimeId: runtime.runtimeId, stateId: runtime.stateId, signal: signal() }),
        previous,
      );
      const at = new Date().toISOString(),
        started = performance.now();
      do {
        check(equal(await delivery(), before), "Delivery changed or duplicated after reconnect.");
        await delay(pollMs, undefined, { signal: signal() });
      } while (performance.now() - started < 30000);
      return result([
        event(
          "reconnect_observation",
          { deliveryCount: 1, pendingDeliveries: 0, observedUntil: new Date().toISOString() },
          at,
        ),
      ]);
    },
    async arm_predispatch_failure() {
      const fault = await supervisor.armPreDispatchFailure({
        runtimeId: runtime.runtimeId,
        providerId: "comparison",
        signal: signal(),
      });
      check(
        fault?.runtimeId === runtime.runtimeId &&
          fault.providerId === "comparison" &&
          fault.boundary === "before_upstream_forward" &&
          fault.controlled === true &&
          fault.maxFaults === 1,
        "Fault setup must target one controlled pre-forward attempt in this owned runtime.",
      );
      await save("predispatch-fault", { fault });
      return result([event("fault_armed", { boundary: fault.boundary, maxFaults: fault.maxFaults, controlled: true })]);
    },
    async run_uncertain_effect_case() {
      const setup = await supervisor.armUncertainEffect({ runtimeId: runtime.runtimeId, signal: signal() });
      check(
        setup?.runtimeId === runtime.runtimeId &&
          identifier(setup.toolName) &&
          typeof setup.prompt === "string" &&
          setup.prompt.length <= 8000 &&
          /^[a-f0-9]{64}$/u.test(setup.argsSha256 ?? ""),
        "Configure one explicitly reviewed uncertain-effect transport case.",
      );
      await save("uncertain-effect-setup", { setup });
      const old = turn;
      turn = undefined;
      const chat = await api("uncertain-session-create", "/chat/sessions", {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        title: "Uncertain effect acceptance",
        mode: "chat",
      });
      scope = { ...scope, sessionId: chat.sessionId };
      check(
        Array.isArray(setup.mcpServerIds) && setup.mcpServerIds.length === 1 && setup.mcpServerIds.every(identifier),
        "Select the exact reviewed marker server for the independent uncertain-effect Chat.",
      );
      check(
        setup.toolName.startsWith(`mcp.${setup.mcpServerIds[0]}.`),
        "The explicit tool mention does not select the reviewed marker server.",
      );
      await send(setup.prompt, {}, false);
      check(turn.trace.durable.runId !== old.trace.durable.runId, "Uncertain effects need an independent native run.");
      const requested = await poll(() => pending(setup.toolName));
      const decision = await supervisor.approve({ approval: requested, signal: signal() });
      check(
        decision?.actorKind === "human" &&
          identifier(decision.actorId) &&
          decision.approvalId === requested.approvalId &&
          decision.decision === "approve",
        "A human must approve this exact controlled marker action.",
      );
      await save("uncertain-effect-approval", { decision, approvalId: requested.approvalId });
      await api("uncertain-approval-resolve", `/approvals/${routeId(requested.approvalId)}/resolve`, {
        decision: "approve",
      });
      turn = await poll(async () => {
        const value = await readTurn();
        return value?.trace.toolRuns.some(
          (tool) =>
            tool.toolName === setup.toolName && tool.effectOutcomeKind === "uncertain" && timestamp(tool.finishedAt),
        )
          ? value
          : undefined;
      });
      const tools = turn.trace.toolRuns.filter(
        (tool) => tool.toolName === setup.toolName && sha256(tool.args) === setup.argsSha256,
      );
      check(
        tools.length === 1 && tools[0].effectDisposition === "unknown" && tools[0].effectOutcomeKind === "uncertain",
        "Native tool trace does not prove an uncertain effect.",
      );
      uncertain = {
        ...turnScope(),
        effectId: tools[0].toolRunId,
        toolName: setup.toolName,
        argsSha256: setup.argsSha256,
      };
      return result([event("uncertain_effect", { ...uncertain, outcome: "unknown_after_send" }, tools[0].finishedAt)]);
    },
    async read_reconciliation() {
      const owner = await durable();
      check(
        ["waiting", "failed", "blocked"].includes(owner.status),
        "The uncertain native run continued instead of stopping for reconciliation.",
      );
      const observationStartedAt = new Date().toISOString();
      await delay(30000, undefined, { signal: signal() });
      const observed = await supervisor.observeEffectTransport({
        runtimeId: runtime.runtimeId,
        ...uncertain,
        signal: signal(),
      });
      check(
        observed?.effectId === uncertain.effectId &&
          observed.toolName === uncertain.toolName &&
          observed.argsSha256 === uncertain.argsSha256 &&
          Array.isArray(observed.dispatches) &&
          observed.dispatches.length === 1 &&
          identifier(observed.dispatches[0].transportReceiptId) &&
          observed.dispatches[0].outcome === "unknown_after_send" &&
          observed.automaticRetries === 0,
        "The external transport observer did not retain one uncertain dispatch with no automatic retries.",
      );
      await save("uncertain-transport-observation", {
        observed,
        observationStartedAt,
        observedAt: new Date().toISOString(),
      });
      return result([
        event("reconciliation_required", {
          ...uncertain,
          status: "blocked",
          dispatchCount: observed.dispatches.length,
          automaticRetries: observed.automaticRetries,
        }),
      ]);
    },
    async await_child_completion() {
      const value = await poll(async () => {
        const current = await readDelegation();
        return current?.steps.some((step) => complete(step.status)) ? current : undefined;
      });
      check(
        value.steps.filter((step) => complete(step.status)).length === 1,
        "Both children settled before the restart boundary; this trial cannot prove partial recovery.",
      );
      firstChild = await readChild(value.steps.find((step) => complete(step.status)));
      return result([firstChild]);
    },
    async read_lineage() {
      const children = await Promise.all(delegation.steps.map(readChild));
      check(
        children.some(
          (child) => child.childId === firstChild.childId && child.resultSha256 === firstChild.resultSha256,
        ),
        "Restart changed the retained first child result.",
      );
      const answer = await artifact("delegation.json");
      return result([
        ...children.filter((child) => child.childId !== firstChild.childId),
        event("synthesis", {
          runId: delegation.run.runId,
          artifactSha256: sha256(answer),
          childResultSha256s: children.map((child) => child.resultSha256),
        }),
      ]);
    },
    async close() {
      if (!closing) {
        abort.abort();
        closing = Promise.resolve().then(() =>
          supervisor.stop({ runtimeId: runtime?.runtimeId, stateId: runtime?.stateId }),
        );
      }
      return closing;
    },
  };
  try {
    await attach(
      await supervisor.start({
        taskId,
        revision,
        workspace: session.workspace,
        connectionFile: session.connectionFile,
        signal: signal(),
      }),
    );
    const review = await supervisor.reviewPermissions({
      taskId,
      runtimeId: runtime.runtimeId,
      configurationSha256: runtime.configurationSha256,
      sourceReceipts: [...receipts],
      signal: signal(),
    });
    check(
      review?.configurationSha256 === runtime.configurationSha256 &&
        identifier(review.reviewedBy) &&
        timestamp(review.reviewedAt),
      "The operator must review this exact runtime configuration and feature-specific permissions.",
    );
    const policy = normalizeComparisonPermissions(review.policy);
    check(
      policy.files === "workspace_only" &&
        (taskId !== "scheduled_agent_work" || policy.schedule === "per_send_approval"),
      "This journey requires workspace-only files and, for delivery, normal per-send approval.",
    );
    await save("feature-permission-review", { review });
    const permission = {
      schemaVersion: PERMISSION_REVIEW_VERSION,
      ...session.binding,
      policy,
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
      sourceReceipts: [...receipts],
    };
    const permissionBytes = Buffer.from(JSON.stringify(permission, null, 2) + "\n");
    const permissionFile = await open(path.join(session.evidence, PERMISSION_REVIEW_FILE), "wx", 0o600);
    try {
      await permissionFile.writeFile(permissionBytes);
      await permissionFile.sync();
    } finally {
      await permissionFile.close();
    }
    receipts.push({ path: PERMISSION_REVIEW_FILE, sha256: sha256(permissionBytes) });
    await createScope();
    return actions;
  } catch (error) {
    await actions.close();
    throw error;
  }
}
