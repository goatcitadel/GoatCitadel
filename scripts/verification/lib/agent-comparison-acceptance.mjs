import { open } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./agent-comparison.mjs";
import { EXECUTION_BINDING_FIELDS } from "./agent-comparison-permissions.mjs";
import { FEATURE_ACCEPTANCE_TASKS } from "./agent-comparison-acceptance-fixtures.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { readFeatureAcceptanceAvailability } from "./agent-comparison-acceptance-profile.mjs";

export const ACCEPTANCE_EXECUTION_VERSION = "goatcitadel.feature-acceptance.execution.v1";
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const id = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
const instant = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const list = (value) => Array.isArray(value) && value.length <= 128;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Adapter/operator-owned actions, never model-provided code. The session's
 * existing provider proxy meters every model attempt. Approval and restart
 * hooks must implement the product's real owners; absent hooks are unsupported.
 * This runner does not fabricate a native product receipt from a model answer. */
export async function runFeatureAcceptance({ taskId, session, source, actions, signal }) {
  const task = FEATURE_ACCEPTANCE_TASKS.find((entry) => entry.id === taskId);
  const records = [];
  const nativeReceipts = [];
  const stop = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const onEnd = () => stop.abort(new Error("Comparison session ended during acceptance."));
  void session.finished.then(onEnd, onEnd);
  try {
    check(
      task && ["native_receipts", "controlled_fixture"].includes(source),
      "Select an opt-in acceptance fixture and evidence source.",
    );
    const start = await readComparisonJson(path.join(session.evidence, "session-start.json"));
    check(
      start.source === source && EXECUTION_BINDING_FIELDS.every((key) => start[key] === session.binding[key]),
      "Acceptance source cannot change the metered session's provenance.",
    );
    if (actions?.availability) {
      const availability = readFeatureAcceptanceAvailability(
        session.binding.cellId.split(":")[0],
        taskId,
        start.profile,
      );
      check(
        availability.status !== "supported" && sha256(availability) === sha256(actions.availability),
        "The no-call disposition does not match the reviewed native constraint.",
      );
      const unavailable = {
        schemaVersion: ACCEPTANCE_EXECUTION_VERSION,
        ...session.binding,
        taskId,
        source,
        availability,
        nativeProcessStarted: false,
      };
      const bytes = Buffer.from(JSON.stringify(unavailable, null, 2) + "\n");
      await writeNew(path.join(session.evidence, "native-acceptance-unavailable.json"), bytes);
      const execution = {
        schemaVersion: "goatcitadel.agent-comparison.execution.v1",
        ...session.binding,
        taskId,
        product: session.binding.cellId.split(":")[0],
        source,
        acceptanceDisposition: availability.status,
        nativeReceipts: [{ path: "native-acceptance-unavailable.json", sha256: sha256(bytes) }],
      };
      await writeNew(
        path.join(session.evidence, "execution.json"),
        Buffer.from(JSON.stringify(execution, null, 2) + "\n"),
      );
      await actions.close?.();
      return { execution, finish: await session.close() };
    }
    check(
      task.phases.every((phase) => typeof actions?.[phase.action] === "function"),
      "Product adapter does not support every required acceptance action.",
    );
    for (const phase of task.phases) {
      activeSignal.throwIfAborted();
      let rejectStop;
      const stopped = new Promise((_, reject) => {
        rejectStop = () => reject(activeSignal.reason);
        activeSignal.addEventListener("abort", rejectStop, { once: true });
      });
      let result;
      try {
        result = await Promise.race([
          actions[phase.action]({ task, phase, session, signal: activeSignal, previous: structuredClone(records) }),
          stopped,
        ]);
      } finally {
        activeSignal.removeEventListener("abort", rejectStop);
      }
      activeSignal.throwIfAborted();
      check(
        result && list(result.records) && result.records.length > 0,
        "Native phase returned no bounded source records.",
      );
      if (result.nativeReceipts !== undefined) {
        check(
          Array.isArray(result.nativeReceipts) &&
            result.nativeReceipts.length <= 500 &&
            result.nativeReceipts.every(
              (ref) => /^native-[A-Za-z0-9][A-Za-z0-9._-]{0,112}\.json$/u.test(ref.path ?? "") && digest(ref.sha256),
            ),
          "Native source references must be bounded, distinct receipt files.",
        );
        nativeReceipts.push(...result.nativeReceipts);
        check(
          nativeReceipts.length <= 500 && new Set(nativeReceipts.map((ref) => ref.path)).size === nativeReceipts.length,
          "Native source receipt references are duplicated or exceed the bound.",
        );
      }
      const material = {
        schemaVersion: ACCEPTANCE_EXECUTION_VERSION,
        ...session.binding,
        taskId,
        source,
        phaseId: phase.id,
        action: phase.action,
        records: result.records,
      };
      check(
        Buffer.byteLength(JSON.stringify(material)) <= 4 * 1024 * 1024,
        "Native acceptance phase exceeds the evidence bound.",
      );
      const filename = `acceptance-${phase.id}.json`;
      const bytes = Buffer.from(JSON.stringify(material, null, 2) + "\n");
      await writeNew(path.join(session.evidence, filename), bytes);
      records.push({ path: filename, sha256: sha256(bytes), phaseId: phase.id });
    }
    const execution = {
      schemaVersion: "goatcitadel.agent-comparison.execution.v1",
      ...session.binding,
      taskId,
      product: session.binding.cellId.split(":")[0],
      source,
      nativeReceipts: [...records, ...nativeReceipts],
    };
    await writeNew(
      path.join(session.evidence, "execution.json"),
      Buffer.from(JSON.stringify(execution, null, 2) + "\n"),
    );
    await actions.close?.();
    return { execution, finish: await session.close() };
  } catch (error) {
    stop.abort(error);
    try {
      await actions?.close?.();
    } finally {
      await session.close();
    }
    throw error;
  }
}

async function writeNew(filename, bytes) {
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Inspect retained native records, exact lineage and computed artifacts. Source
 * review is an explicit human receipt: text overlap alone cannot prove a claim.
 * Source kind remains controlled/live in the outer verifier and never upgrades. */
export async function verifyFeatureAcceptance({ taskId, execution, readEvidence, readWorkspace }) {
  const task = FEATURE_ACCEPTANCE_TASKS.find((entry) => entry.id === taskId);
  check(task, "Unknown feature acceptance task.");
  const start = JSON.parse(await readEvidence("session-start.json"));
  check(
    start.source === execution.source && EXECUTION_BINDING_FIELDS.every((key) => start[key] === execution[key]),
    "Acceptance evidence changed the metered session's provenance.",
  );
  if (execution.acceptanceDisposition !== undefined) {
    const expected = readFeatureAcceptanceAvailability(execution.product, taskId, start.profile);
    const raw = await readEvidence("native-acceptance-unavailable.json");
    const value = JSON.parse(raw),
      ref = execution.nativeReceipts.find((entry) => entry.path === "native-acceptance-unavailable.json");
    check(
      expected.status !== "supported" &&
        execution.acceptanceDisposition === expected.status &&
        ref?.sha256 === sha256(raw) &&
        execution.nativeReceipts.length === 1 &&
        value.schemaVersion === ACCEPTANCE_EXECUTION_VERSION &&
        value.source === execution.source &&
        value.taskId === taskId &&
        value.nativeProcessStarted === false &&
        sha256(value.availability) === sha256(expected) &&
        EXECUTION_BINDING_FIELDS.every((key) => value[key] === execution[key]),
      "The no-call evidence changed its native limitation or exact session binding.",
    );
    return Object.fromEntries(task.criteria.map((criterion) => [criterion, false]));
  }
  const all = [];
  for (const phase of task.phases) {
    const filename = `acceptance-${phase.id}.json`;
    const ref = execution.nativeReceipts.find((entry) => entry.path === filename);
    check(ref && digest(ref.sha256), "Required native acceptance phase is missing.");
    const raw = await readEvidence(filename);
    check(sha256(raw) === ref.sha256, "Acceptance phase bytes changed.");
    const value = JSON.parse(raw);
    check(
      value.schemaVersion === ACCEPTANCE_EXECUTION_VERSION &&
        value.taskId === taskId &&
        value.source === execution.source &&
        value.phaseId === phase.id &&
        value.action === phase.action &&
        list(value.records) &&
        value.records.length > 0 &&
        EXECUTION_BINDING_FIELDS.every((key) => id(value[key]) && value[key] === execution[key]),
      "Native acceptance phase binding changed.",
    );
    for (const record of value.records) {
      check(record && id(record.kind) && id(record.id) && instant(record.at), "Native acceptance record is malformed.");
      all.push({ ...record, phaseId: phase.id });
    }
  }
  check(
    all.length <= 128 && new Set(all.map((entry) => entry.id)).size === all.length,
    "Acceptance records are duplicated or exceed the bound.",
  );
  const records = (kind) => all.filter((entry) => entry.kind === kind);
  const one = (kind) => {
    const values = records(kind);
    return values.length === 1 ? values[0] : undefined;
  };
  const same = (left, right, fields) =>
    Boolean(left && right && fields.every((field) => id(left[field]) && left[field] === right[field]));
  const ordered = (...values) =>
    values.every((entry) => entry && instant(entry.at)) &&
    values.every((entry, index) => index === 0 || Date.parse(values[index - 1].at) <= Date.parse(entry.at));
  const verdict = Object.fromEntries(task.criteria.map((criterion) => [criterion, false]));
  if (taskId === "web_research") {
    const searches = records("web_search"),
      sources = records("web_source"),
      review = one("source_review");
    const answer = JSON.parse(await readWorkspace("research.json"));
    const validSource = (entry) => {
      try {
        const url = new URL(entry.url);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          (entry.status === 200 ||
            (execution.product === "hermes" &&
              entry.status === null &&
              entry.sourceEvidence === "hermes_native_extraction" &&
              entry.extractionSucceeded === true)) &&
          typeof entry.text === "string" &&
          entry.text.length <= 262144 &&
          sha256(entry.text) === entry.contentSha256 &&
          searches.some((search) => list(search.resultUrls) && search.resultUrls.includes(entry.url))
        );
      } catch {
        return false;
      }
    };
    const opened = sources.filter(validSource);
    verdict.discovers_multiple_sources =
      searches.some((entry) => typeof entry.query === "string" && entry.query.trim()) &&
      new Set(opened.map((entry) => new URL(entry.url).hostname)).size >= 2;
    const claims = answer.claims;
    verdict.claims_match_cited_sources =
      list(claims) &&
      claims.length >= 2 &&
      review?.reviewerKind === "human" &&
      id(review.reviewerId) &&
      review.artifactSha256 === sha256(answer) &&
      list(review.claims) &&
      claims.every(
        (claim) =>
          id(claim.id) &&
          typeof claim.text === "string" &&
          typeof claim.quote === "string" &&
          claim.quote.length > 0 &&
          opened.some((source) => source.url === claim.url && source.text.includes(claim.quote)) &&
          review.claims.some(
            (item) => item.claimId === claim.id && item.claimSha256 === sha256(claim) && item.supported === true,
          ),
      );
    verdict.conflicting_evidence_disclosed =
      list(answer.conflicts) &&
      list(review?.conflicts) &&
      review.conflicts.every(
        (conflict) =>
          list(conflict.claimIds) &&
          conflict.claimIds.length >= 2 &&
          answer.conflicts.some(
            (entry) =>
              sha256(entry.claimIds) === sha256(conflict.claimIds) &&
              typeof entry.explanation === "string" &&
              entry.explanation.trim(),
          ),
      ) &&
      review?.conflictSearchCompleted === true;
  } else if (taskId === "scheduled_agent_work") {
    const occurrence = one("scheduled_occurrence"),
      admission = one("turn_admitted"),
      pending = one("approval_pending"),
      approval = one("approval"),
      restart = one("runtime_restart"),
      resumed = one("turn_resumed") ?? one("delivery_resumed"),
      reconnect = one("reconnect_observation"),
      effects = records("delivery_receipt"),
      tools = records("tool_result");
    verdict.durable_agent_turn_admitted =
      occurrence?.mode === "agent_turn" &&
      same(occurrence, admission, ["occurrenceId", "runId"]) &&
      id(admission?.turnId);
    verdict.tools_run_under_current_authority =
      tools.length > 0 &&
      tools.every(
        (tool) =>
          same(tool, admission, ["runId", "turnId"]) && tool.status === "completed" && digest(tool.authoritySha256),
      ) &&
      tools.some(
        (tool) =>
          tool.toolName === "fs.read" &&
          tool.path === "input/ledger.json" &&
          tool.resultSha256 === sha256({ amountsCents: [130, 270, 600] }),
      );
    verdict.approval_resume_after_restart =
      same(pending, approval, ["approvalId", "runId", "turnId"]) &&
      same(approval, resumed, ["approvalId", "runId", "turnId"]) &&
      same(admission, resumed, ["runId", "turnId"]) &&
      approval?.decision === "approved" &&
      approval?.actorKind === "human" &&
      id(approval.actorId) &&
      ordered(admission, pending, restart, approval, resumed) &&
      restart.previousRuntimeId !== restart.runtimeId &&
      id(restart.runtimeId) &&
      resumed.runtimeId === restart.runtimeId &&
      (resumed.kind !== "delivery_resumed" || id(resumed.deliveryRunId));
    verdict.no_duplicate_external_effect =
      effects.length === 1 &&
      same(effects[0], admission, ["runId", "turnId"]) &&
      effects[0].totalCents === 1000 &&
      id(effects[0].providerMessageId) &&
      effects[0].destination === occurrence?.authorizedDestination &&
      id(occurrence?.authorizedDestination) &&
      reconnect?.pendingDeliveries === 0 &&
      reconnect?.deliveryCount === 1 &&
      ordered(resumed, effects[0], reconnect) &&
      Date.parse(reconnect.observedUntil) >= Date.parse(reconnect.at) + 30000;
  } else if (taskId === "provider_recovery") {
    const attempts = records("provider_attempt"),
      visible = one("provider_changed"),
      uncertain = one("uncertain_effect"),
      blocked = one("reconciliation_required");
    const artifact = JSON.parse(await readWorkspace("recovery.json"));
    verdict.bounded_retry =
      attempts.length === 2 &&
      same(attempts[0], attempts[1], ["runId", "turnId"]) &&
      (attempts[0].outcome === "confirmed_not_dispatched" ||
        (attempts[0].outcome === "controlled_pre_forward_failure" &&
          attempts[0].controlled === true &&
          attempts[0].nativeTransportReachedFixture === true &&
          attempts[0].upstreamForwarded === false &&
          attempts[0].usefulOutputBytes === 0 &&
          id(attempts[0].transportReceiptId) &&
          digest(attempts[0].transportReceiptSha256) &&
          one("fault_armed")?.boundary === "before_upstream_forward" &&
          one("fault_armed")?.controlled === true)) &&
      attempts[1].outcome === "completed" &&
      attempts[0].providerId !== attempts[1].providerId &&
      artifact.totalCents === 1000;
    verdict.visible_provider_change =
      same(visible, attempts[1], ["runId", "turnId"]) &&
      visible?.fromProviderId === attempts[0]?.providerId &&
      visible?.toProviderId === attempts[1]?.providerId &&
      visible?.surface === "chat" &&
      digest(visible.routeReferenceSha256);
    verdict.no_replay_after_uncertain_side_effect =
      uncertain?.outcome === "unknown_after_send" &&
      uncertain.runId !== attempts[0]?.runId &&
      same(uncertain, blocked, ["runId", "turnId", "effectId"]) &&
      blocked?.status === "blocked" &&
      blocked?.dispatchCount === 1 &&
      blocked?.automaticRetries === 0 &&
      ordered(uncertain, blocked);
  } else if (taskId === "delegation") {
    const plan = one("delegation_plan"),
      children = records("child_result"),
      restart = one("runtime_restart"),
      recovery = one("delegation_recovered"),
      synthesis = one("synthesis");
    const artifact = JSON.parse(await readWorkspace("delegation.json"));
    verdict.observable_plan =
      id(plan?.runId) &&
      plan?.surface === "chat" &&
      list(plan.childIds) &&
      plan.childIds.length === 2 &&
      new Set(plan.childIds).size === 2;
    verdict.bounded_child_budgets =
      children.length === 2 &&
      children.every(
        (child) =>
          Number.isInteger(child.maxRequests) &&
          child.maxRequests > 0 &&
          child.maxRequests <= 10 &&
          Number.isInteger(child.requests) &&
          child.requests > 0 &&
          child.requests <= child.maxRequests &&
          Number.isInteger(child.maxTokens) &&
          child.maxTokens > 0 &&
          Number.isInteger(child.tokens) &&
          child.tokens >= 0 &&
          child.tokens <= child.maxTokens,
      );
    verdict.retained_lineage =
      children.length === 2 &&
      new Set(children.map((child) => child.childId)).size === 2 &&
      children.every(
        (child) =>
          same(child, plan, ["runId"]) &&
          plan.childIds.includes(child.childId) &&
          digest(child.resultSha256) &&
          child.resultSha256 === sha256(child.result),
      ) &&
      same(recovery, plan, ["runId"]) &&
      recovery?.spawnedChildren === 2 &&
      sha256(recovery.childIds) === sha256(plan.childIds) &&
      ordered(plan, children[0], restart, recovery) &&
      restart?.previousRuntimeId !== restart?.runtimeId;
    verdict.verified_synthesis =
      artifact.northCents === 400 &&
      artifact.southCents === 600 &&
      artifact.totalCents === 1000 &&
      same(synthesis, plan, ["runId"]) &&
      synthesis?.artifactSha256 === sha256(artifact) &&
      children.some((child) => child.result?.region === "north" && child.result.totalCents === 400) &&
      children.some((child) => child.result?.region === "south" && child.result.totalCents === 600) &&
      children.length === 2 &&
      sha256(synthesis.childResultSha256s?.slice().sort()) ===
        sha256(children.map((child) => child.resultSha256).sort());
  }
  return verdict;
}
