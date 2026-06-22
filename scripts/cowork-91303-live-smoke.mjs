#!/usr/bin/env node
/* global AbortSignal, fetch, setTimeout */
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROMPT =
  "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?";

const TURN_TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const TURN_BLOCKED_STATUSES = new Set(["waiting_for_approval", "waiting_for_user_input"]);
const TURN_SETTLED_STATUSES = new Set([...TURN_TERMINAL_STATUSES, ...TURN_BLOCKED_STATUSES]);
const TREE_ACTIVE_STATUS_PATTERN = /\b(?:queued|pending|planning|running|in_progress|waiting_for_tool|starting)\b/i;
const TREE_BLOCKED_STATUS_PATTERN =
  /\b(?:approval_required|waiting_for_approval|waiting_for_user_input|paused|blocked)\b/i;
const WINDOWS_CMD = "C:\\Windows\\System32\\cmd.exe";
const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 3_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function printHelp() {
  process.stdout.write(`GoatCitadel Cowork 91303 live smoke

Runs the exact Cowork prompt through a live Gateway HTTP runtime, polls the chat turn
trace plus /api/v1/agentic/runs/:runId/tree, and writes compact JSON/Markdown artifacts.

Usage:
  node scripts/cowork-91303-live-smoke.mjs [options]

Options:
  --port <number>              Gateway port to start. Defaults to a free loopback port.
  --gateway-url <url>          Use an already-running Gateway instead of starting one.
  --runtime-root <path>        GOATCITADEL_ROOT_DIR for the Gateway. Defaults to a temp root.
  --keep-runtime-root          Do not remove the temp runtime root after the run.
  --artifact-root <path>       Output root. Defaults to artifacts/cowork-smoke.
  --timeout-ms <number>        Overall poll/send timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --poll-ms <number>           Poll interval. Default: ${DEFAULT_POLL_MS}.
  --provider-id <id>           Optional provider pin for preflight.
  --model <id>                 Optional model pin for preflight.
  --gateway-mode <source|dev|built>
                               Start source main, dev supervisor, or built dist main. Default: source.
  --help                       Show this help.

Example:
  node .\\scripts\\cowork-91303-live-smoke.mjs --port 18913 --timeout-ms 900000
`);
}

function parseArgs(argv) {
  const options = {
    artifactRoot: path.join(repoRoot, "artifacts", "cowork-smoke"),
    gatewayMode: "source",
    keepRuntimeRoot: false,
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--keep-runtime-root") {
      options.keepRuntimeRoot = true;
      continue;
    }
    const [flag, inlineValue] = token.includes("=") ? token.split(/=(.*)/s, 2) : [token, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--artifact-root":
        options.artifactRoot = path.resolve(readValue());
        break;
      case "--gateway-mode":
        options.gatewayMode = readValue();
        break;
      case "--gateway-url":
        options.gatewayUrl = trimTrailingSlash(readValue());
        break;
      case "--model":
        options.model = readValue();
        break;
      case "--poll-ms":
        options.pollMs = readPositiveInt(readValue(), "--poll-ms");
        break;
      case "--port":
        options.port = readPort(readValue());
        break;
      case "--provider-id":
        options.providerId = readValue();
        break;
      case "--runtime-root":
        options.runtimeRoot = path.resolve(readValue());
        options.keepRuntimeRoot = true;
        break;
      case "--timeout-ms":
        options.timeoutMs = readPositiveInt(readValue(), "--timeout-ms");
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (!["source", "dev", "built"].includes(options.gatewayMode)) {
    throw new Error("--gateway-mode must be source, dev, or built.");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runId = buildRunId();
  const artifactDir = path.join(options.artifactRoot, runId);
  await fs.mkdir(path.join(artifactDir, "diagnostics"), { recursive: true });

  const state = {
    runId,
    startedAt: new Date().toISOString(),
    prompt: PROMPT,
    gateway: {
      mode: options.gatewayUrl ? "existing" : options.gatewayMode,
      url: options.gatewayUrl,
      port: options.port,
      runtimeRoot: options.runtimeRoot,
    },
    session: {},
    routePreflight: undefined,
    sendResponse: undefined,
    thread: undefined,
    turn: undefined,
    tree: undefined,
    runList: undefined,
    blockers: [],
  };

  let runtimeRootCreatedByScript = false;
  let gatewayHandle;
  try {
    let runtimeRoot = options.runtimeRoot;
    if (!options.gatewayUrl) {
      if (!runtimeRoot) {
        runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-cowork-91303-"));
        runtimeRootCreatedByScript = true;
      }
      await prepareRuntimeRoot(runtimeRoot);
      const port = options.port ?? (await resolveAvailablePort());
      state.gateway.port = port;
      state.gateway.runtimeRoot = runtimeRoot;
      state.gateway.url = `http://127.0.0.1:${port}`;
      gatewayHandle = await startGateway({
        artifactDir,
        gatewayMode: options.gatewayMode,
        port,
        runtimeRoot,
      });
      await waitForHealth(state.gateway.url, "Gateway health", options.timeoutMs, gatewayHandle);
    }

    const gatewayUrl = state.gateway.url;
    if (!gatewayUrl) {
      throw new Error("No Gateway URL resolved.");
    }

    const createdSession = await requestJson(gatewayUrl, "/api/v1/chat/sessions", {
      method: "POST",
      timeoutMs: 30_000,
      body: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        title: "Cowork 91303 local-business live smoke",
        mode: "cowork",
        origin: "operator",
        includeInHistory: false,
        tags: ["smoke", "cowork", "91303"],
      },
    });
    if (!createdSession.ok) {
      throw new Error(
        `Failed to create Cowork session: HTTP ${createdSession.status} ${formatBody(createdSession.body)}`,
      );
    }
    state.session.sessionId = readString(createdSession.body, "sessionId");
    if (!state.session.sessionId) {
      throw new Error(`Cowork session response did not include sessionId: ${formatBody(createdSession.body)}`);
    }

    const routePayload = buildRoutePreflightPayload(options);
    const preflight = await requestJson(
      gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(state.session.sessionId)}/route-preflight`,
      {
        method: "POST",
        timeoutMs: 30_000,
        body: routePayload,
      },
    );
    state.routePreflight = compactHttpResult(preflight);
    if (!preflight.ok) {
      state.blockers.push({
        code: "route_preflight_failed",
        message: `Route preflight failed with HTTP ${preflight.status}.`,
        detail: preflight.body,
      });
      return await writeArtifactsAndExit(state, artifactDir, 1);
    }

    const preflightBody = isRecord(preflight.body) ? preflight.body : {};
    if (typeof preflightBody.blockedReason === "string" && preflightBody.blockedReason.trim()) {
      state.blockers.push({
        code: "route_preflight_blocked",
        message: preflightBody.blockedReason,
      });
      return await writeArtifactsAndExit(state, artifactDir, 1);
    }

    const routeDecision = isRecord(preflightBody.decision) ? preflightBody.decision : undefined;
    if (!routeDecision) {
      state.blockers.push({
        code: "route_decision_missing",
        message: "Route preflight response did not include a decision snapshot required by /agent-send.",
        detail: preflight.body,
      });
      return await writeArtifactsAndExit(state, artifactDir, 1);
    }

    const sendPayload = buildSendPayload(options, routeDecision);
    try {
      const send = await requestJson(
        gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.session.sessionId)}/agent-send`,
        {
          method: "POST",
          timeoutMs: options.timeoutMs,
          body: sendPayload,
        },
      );
      state.sendResponse = compactHttpResult(send);
      if (!send.ok) {
        state.blockers.push({
          code: "agent_send_failed",
          message: `Agent send failed with HTTP ${send.status}.`,
          detail: send.body,
        });
      } else {
        const sendBody = isRecord(send.body) ? send.body : {};
        state.session.turnId = readString(sendBody, "turnId") ?? readString(sendBody.trace, "turnId");
        state.session.agenticRunId = readRunIdFromTrace(sendBody.trace);
        state.finalAnswer = readNestedString(sendBody, "assistantMessage", "content");
      }
    } catch (error) {
      state.blockers.push({
        code: "agent_send_request_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    await pollUntilSettled({
      gatewayUrl,
      sessionId: state.session.sessionId,
      state,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    });

    return await writeArtifactsAndExit(
      state,
      artifactDir,
      ["pass", "blocked"].includes(state.acceptanceVerdict?.status) ? 0 : 1,
    );
  } catch (error) {
    state.blockers.push({
      code: "harness_error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return await writeArtifactsAndExit(state, artifactDir, 1);
  } finally {
    if (gatewayHandle) {
      await stopProcess(gatewayHandle);
    }
    if (runtimeRootCreatedByScript && state.gateway.runtimeRoot && !options.keepRuntimeRoot) {
      await removeRuntimeRoot(state.gateway.runtimeRoot);
      state.gateway.runtimeRootRemoved = true;
    }
  }
}

function buildRoutePreflightPayload(options) {
  return compactRecord({
    action: "send",
    providerId: options.providerId,
    model: options.model,
    mode: "cowork",
    webMode: "deep",
    thinkingLevel: "deep",
    speedMode: "standard",
    subagentPolicy: "auto_when_useful",
    prefsOverride: {
      mode: "cowork",
      providerId: options.providerId,
      model: options.model,
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "deep",
      speedMode: "standard",
      subagentPolicy: "auto_when_useful",
      orchestrationEnabled: true,
      orchestrationIntensity: "deep",
      orchestrationVisibility: "explicit",
      orchestrationProviderPreference: "quality",
      orchestrationReviewDepth: "standard",
      orchestrationParallelism: "auto",
      toolAutonomy: "safe_auto",
    },
  });
}

function buildSendPayload(options, routeDecision) {
  const effectiveProviderId = readString(routeDecision, "effectiveProviderId");
  const effectiveModel = readString(routeDecision, "effectiveModel");
  return compactRecord({
    content: PROMPT,
    mode: "cowork",
    providerId: effectiveProviderId,
    model: effectiveModel,
    fullWebAccess: true,
    webMode: "deep",
    memoryMode: "off",
    thinkingLevel: "deep",
    speedMode: "standard",
    subagentPolicy: "auto_when_useful",
    prefsOverride: {
      mode: "cowork",
      providerId: options.providerId,
      model: options.model,
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "deep",
      speedMode: "standard",
      subagentPolicy: "auto_when_useful",
      orchestrationEnabled: true,
      orchestrationIntensity: "deep",
      orchestrationVisibility: "explicit",
      orchestrationProviderPreference: "quality",
      orchestrationReviewDepth: "standard",
      orchestrationParallelism: "auto",
      toolAutonomy: "safe_auto",
    },
    routeDecision,
  });
}

async function pollUntilSettled({ gatewayUrl, sessionId, state, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const snapshot = await readRuntimeSnapshot(gatewayUrl, sessionId, state);
      Object.assign(state, snapshot);
      state.acceptanceVerdict = buildAcceptanceVerdict(state);
      if (snapshot.settled) {
        return;
      }
    } catch (error) {
      lastError = error;
      state.blockers.push({
        code: "poll_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await delay(pollMs);
  }

  state.blockers.push({
    code: "poll_timeout",
    message: `Timed out after ${timeoutMs}ms before turn trace and agentic tree reached terminal truth.`,
    detail: lastError instanceof Error ? lastError.message : undefined,
  });
  const snapshot = await readRuntimeSnapshot(gatewayUrl, sessionId, state).catch(() => ({}));
  Object.assign(state, snapshot);
  state.acceptanceVerdict = buildAcceptanceVerdict(state);
}

async function readRuntimeSnapshot(gatewayUrl, sessionId, state) {
  const threadResponse = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
    { timeoutMs: 30_000 },
  );
  if (!threadResponse.ok) {
    throw new Error(`Thread poll failed with HTTP ${threadResponse.status}: ${formatBody(threadResponse.body)}`);
  }
  const thread = isRecord(threadResponse.body) ? threadResponse.body : {};
  const turn = findTargetTurn(thread, state.session.turnId);
  const trace = isRecord(turn?.trace)
    ? turn.trace
    : isRecord(state.sendResponse?.body?.trace)
      ? state.sendResponse.body.trace
      : undefined;
  const turnId = readString(turn, "turnId") ?? readString(trace, "turnId") ?? state.session.turnId;
  const agenticRunId =
    readRunIdFromTrace(trace) ??
    state.session.agenticRunId ??
    (await findAgenticRunIdForSession(gatewayUrl, sessionId, state).catch(() => undefined));
  let tree;
  let treeError;
  if (agenticRunId) {
    const treeResponse = await requestJson(
      gatewayUrl,
      `/api/v1/agentic/runs/${encodeURIComponent(agenticRunId)}/tree?workspaceId=${encodeURIComponent(DEFAULT_WORKSPACE_ID)}`,
      { timeoutMs: 30_000 },
    );
    if (treeResponse.ok && isRecord(treeResponse.body)) {
      tree = treeResponse.body;
    } else {
      treeError = {
        status: treeResponse.status,
        body: treeResponse.body,
      };
    }
  }

  const finalAnswer = readNestedString(turn, "assistantMessage", "content") ?? state.finalAnswer;
  const childStates = deriveChildStates(tree, trace);
  const localBusinessEvidenceSummary = summarizeLocalBusinessEvidence({ finalAnswer, trace, tree });
  const settled = isTurnSettled(trace) && isTreeSettled({ tree, treeError, agenticRunId });
  const blockers = dedupeBlockers([
    ...filterResolvedHarnessBlockers(state.blockers, { finalAnswer, settled, localBusinessEvidenceSummary }),
    ...deriveRuntimeBlockers({
      turn,
      trace,
      tree,
      treeError,
      agenticRunId,
      localBusinessEvidenceSummary,
    }),
  ]);

  return {
    session: {
      ...state.session,
      turnId,
      agenticRunId,
    },
    thread: compactThread(thread, turnId),
    turn: compactTurn(turn),
    tree: compactTree(tree),
    treeError,
    childStates,
    finalAnswer,
    localBusinessEvidenceSummary,
    blockers,
    settled,
  };
}

function filterResolvedHarnessBlockers(blockers, { finalAnswer, settled, localBusinessEvidenceSummary }) {
  if (!settled || !finalAnswer?.trim()) {
    return blockers;
  }
  const hasLocalBusinessEvidence = (localBusinessEvidenceSummary?.localBusinessAnnotationCount ?? 0) > 0;
  return blockers.filter(
    (blocker) =>
      blocker.code !== "agent_send_request_error" &&
      blocker.code !== "poll_error" &&
      !(hasLocalBusinessEvidence && blocker.code === "local_business_annotation_missing"),
  );
}

async function findAgenticRunIdForSession(gatewayUrl, sessionId, state) {
  const response = await requestJson(
    gatewayUrl,
    `/api/v1/agentic/runs?workspaceId=${encodeURIComponent(DEFAULT_WORKSPACE_ID)}&surface=cowork&sessionId=${encodeURIComponent(sessionId)}&limit=20`,
    { timeoutMs: 30_000 },
  );
  if (!response.ok || !isRecord(response.body) || !Array.isArray(response.body.items)) {
    return undefined;
  }
  state.runList = response.body;
  const item =
    response.body.items.find((candidate) => readString(candidate, "parentSessionId") === sessionId) ??
    response.body.items.find((candidate) => readString(candidate, "title")?.includes("91303")) ??
    response.body.items[0];
  return readString(item, "runId");
}

function findTargetTurn(thread, knownTurnId) {
  if (!isRecord(thread) || !Array.isArray(thread.turns)) {
    return undefined;
  }
  if (knownTurnId) {
    const exact = thread.turns.find((turn) => readString(turn, "turnId") === knownTurnId);
    if (exact) {
      return exact;
    }
  }
  const promptMatches = thread.turns.filter((turn) => {
    const content = readNestedString(turn, "userMessage", "content") ?? "";
    return content.includes("91303") && /boardgame|tabletop/i.test(content);
  });
  return promptMatches.at(-1) ?? thread.turns.at(-1);
}

function readRunIdFromTrace(trace) {
  if (!isRecord(trace)) {
    return undefined;
  }
  const orchestrationRunId = readNestedString(trace, "orchestration", "runId");
  if (orchestrationRunId) {
    return orchestrationRunId;
  }
  return undefined;
}

function isTurnSettled(trace) {
  const status = readString(trace, "status");
  return Boolean(status && TURN_SETTLED_STATUSES.has(status));
}

function isTreeSettled({ tree, treeError, agenticRunId }) {
  if (!agenticRunId) {
    return true;
  }
  if (treeError) {
    return true;
  }
  if (!isRecord(tree) || !Array.isArray(tree.nodes)) {
    return false;
  }
  return !tree.nodes.some((node) => TREE_ACTIVE_STATUS_PATTERN.test(readString(node, "status") ?? ""));
}

function deriveRuntimeBlockers({ turn, trace, tree, treeError, agenticRunId, localBusinessEvidenceSummary }) {
  const blockers = [];
  const status = readString(trace, "status");
  if (!trace) {
    blockers.push({ code: "turn_trace_missing", message: "No turn trace was available from the chat thread." });
  } else if (status === "failed" || status === "cancelled") {
    blockers.push({
      code: `turn_${status}`,
      message: readNestedString(trace, "failure", "message") ?? `Turn ended with status ${status}.`,
    });
  } else if (TURN_BLOCKED_STATUSES.has(status)) {
    blockers.push({
      code: `turn_${status}`,
      message:
        readNestedString(trace, "pendingUserInput", "title") ??
        readNestedString(trace, "pendingApprovalSummary", "description") ??
        `Turn is ${status}.`,
    });
  }
  if (!readNestedString(turn, "assistantMessage", "content") && isTurnSettled(trace)) {
    blockers.push({ code: "final_answer_missing", message: "Settled turn did not expose an assistant final answer." });
  }
  if (!agenticRunId) {
    blockers.push({
      code: "agentic_run_id_missing",
      message: "No Cowork agentic run ID was linked from trace or run list.",
    });
  }
  if (treeError) {
    blockers.push({
      code: "agentic_tree_unavailable",
      message: `Agentic tree endpoint failed with HTTP ${treeError.status}.`,
      detail: treeError.body,
    });
  }
  if (isRecord(tree) && Array.isArray(tree.nodes)) {
    for (const node of tree.nodes) {
      const statusText = readString(node, "status") ?? "";
      if (TREE_BLOCKED_STATUS_PATTERN.test(statusText) || /\bfailed|cancelled\b/i.test(statusText)) {
        blockers.push({
          code: "tree_node_not_successful",
          message: `${readString(node, "label") ?? readString(node, "id") ?? "Tree node"} is ${statusText}.`,
        });
      }
    }
  }
  if ((localBusinessEvidenceSummary.localBusinessAnnotationCount ?? 0) === 0) {
    blockers.push({
      code: "local_business_annotation_missing",
      message: "No local-business research annotation was found in retained trace/tree evidence.",
    });
  }
  return blockers;
}

function deriveChildStates(tree, trace) {
  const childStates = [];
  if (isRecord(trace?.orchestration) && Array.isArray(trace.orchestration.steps)) {
    for (const step of trace.orchestration.steps) {
      childStates.push(
        compactRecord({
          source: "turn_trace.orchestration",
          id: readString(step, "stepId"),
          role: readString(step, "role"),
          label: readString(step, "label"),
          status: readString(step, "status"),
          waitStatus: readString(step, "waitStatus"),
          startedAt: readString(step, "startedAt"),
          finishedAt: readString(step, "finishedAt"),
          error: readString(step, "error"),
        }),
      );
    }
  }
  if (isRecord(tree) && Array.isArray(tree.nodes)) {
    for (const node of tree.nodes) {
      if (readString(node, "kind") === "subagent" || readString(node, "kind") === "task") {
        childStates.push(
          compactRecord({
            source: "agentic_tree",
            id: readString(node, "id"),
            kind: readString(node, "kind"),
            label: readString(node, "label"),
            status: readString(node, "status"),
            taskId: readString(node, "taskId"),
            agentSessionId: readString(node, "agentSessionId"),
            summary: readString(node, "summary"),
          }),
        );
      }
    }
  }
  return childStates;
}

function summarizeLocalBusinessEvidence({ finalAnswer, trace, tree }) {
  const annotations = [];
  collectLocalBusinessAnnotations(trace, annotations);
  collectLocalBusinessAnnotations(tree, annotations);

  const candidates = annotations.flatMap((annotation) =>
    Array.isArray(annotation.candidates) ? annotation.candidates : [],
  );
  const stages = annotations.flatMap((annotation) => (Array.isArray(annotation.stages) ? annotation.stages : []));
  const blockers = [
    ...annotations.flatMap((annotation) => (Array.isArray(annotation.blockers) ? annotation.blockers : [])),
    ...candidates.flatMap((candidate) => (Array.isArray(candidate.blockers) ? candidate.blockers : [])),
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  const sourceUrls = new Set();
  for (const candidate of candidates) {
    if (Array.isArray(candidate.sourceUrls)) {
      for (const url of candidate.sourceUrls) {
        if (typeof url === "string") {
          sourceUrls.add(url);
        }
      }
    }
    if (Array.isArray(candidate.evidence)) {
      for (const evidence of candidate.evidence) {
        const url = readString(evidence, "url");
        if (url) {
          sourceUrls.add(url);
        }
      }
    }
  }

  const toolRuns = Array.isArray(trace?.toolRuns) ? trace.toolRuns : [];
  const browserSearchRuns = toolRuns.filter((toolRun) => readString(toolRun, "toolName") === "browser.search").length;
  const browserNavigateRuns = toolRuns.filter(
    (toolRun) => readString(toolRun, "toolName") === "browser.navigate",
  ).length;
  const finalAnswerText = typeof finalAnswer === "string" ? finalAnswer : "";
  const finalEmails = [...finalAnswerText.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0]);

  return {
    localBusinessAnnotationCount: annotations.length,
    candidateCount: candidates.length,
    verifiedCandidateCount: candidates.filter((candidate) => readString(candidate, "verificationStatus") === "verified")
      .length,
    partialCandidateCount: candidates.filter((candidate) => readString(candidate, "verificationStatus") === "partial")
      .length,
    unverifiedCandidateCount: candidates.filter(
      (candidate) => readString(candidate, "verificationStatus") === "unverified",
    ).length,
    candidateEmailCount: candidates.filter((candidate) => Boolean(readString(candidate, "email"))).length,
    candidateContactNameCount: candidates.filter((candidate) => Boolean(readString(candidate, "contactName"))).length,
    finalAnswerEmailCount: finalEmails.length,
    finalAnswerEmails: unique(finalEmails).slice(0, 20),
    sourceUrlCount: sourceUrls.size,
    sourceUrls: [...sourceUrls].slice(0, 20),
    stages: stages.map((stage) =>
      compactRecord({
        name: readString(stage, "name"),
        status: readString(stage, "status"),
        summary: readString(stage, "summary"),
        resultCount: readNumber(stage, "resultCount"),
        candidateCount: readNumber(stage, "candidateCount"),
        excludedCount: readNumber(stage, "excludedCount"),
      }),
    ),
    blockers: unique(blockers).slice(0, 30),
    toolEvidence: {
      browserSearchRuns,
      browserNavigateRuns,
      toolRunCount: toolRuns.length,
      citationCount: Array.isArray(trace?.citations) ? trace.citations.length : 0,
    },
  };
}

function collectLocalBusinessAnnotations(value, out, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (isRecord(value) && value.kind === "local_business_contact_research") {
    out.push(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLocalBusinessAnnotations(item, out, seen);
    }
    return;
  }
  for (const child of Object.values(value)) {
    collectLocalBusinessAnnotations(child, out, seen);
  }
}

function buildAcceptanceVerdict(state) {
  const reasons = [];
  const trace = isRecord(state.turn?.trace) ? state.turn.trace : undefined;
  const status = readString(trace, "status");
  const blocked = Boolean(status && TURN_BLOCKED_STATUSES.has(status));
  if (!status || !TURN_SETTLED_STATUSES.has(status)) {
    reasons.push(status ? `turn status is ${status}` : "turn trace is missing");
  }
  if (!state.session.agenticRunId) {
    reasons.push("agentic run ID missing");
  }
  if (state.treeError) {
    reasons.push("agentic tree unavailable");
  }
  if (state.tree && !isTreeSettled({ tree: state.tree, agenticRunId: state.session.agenticRunId })) {
    reasons.push("agentic tree still has active nodes");
  }
  if (!blocked && !state.finalAnswer?.trim()) {
    reasons.push("final answer missing");
  }
  if ((state.localBusinessEvidenceSummary?.localBusinessAnnotationCount ?? 0) === 0) {
    reasons.push("local-business annotation missing");
  }
  const hardBlockers = state.blockers.filter(
    (blocker) => !["local_business_annotation_missing"].includes(blocker.code),
  );
  if (hardBlockers.length > 0) {
    reasons.push(`${hardBlockers.length} runtime blocker(s) recorded`);
  }
  if (reasons.length === 0) {
    return {
      status: "pass",
      summary: "Cowork prompt reached terminal trace/tree truth with retained local-business evidence.",
      reasons: [],
    };
  }
  return {
    status: blocked ? "blocked" : "fail",
    summary: blocked
      ? "Cowork prompt reached terminal runtime truth at an operator/user-input gate."
      : "Cowork prompt did not satisfy the live-smoke acceptance criteria.",
    reasons: unique(reasons),
  };
}

function compactThread(thread, turnId) {
  if (!isRecord(thread)) {
    return undefined;
  }
  return {
    sessionId: readString(thread, "sessionId"),
    activeLeafTurnId: readString(thread, "activeLeafTurnId"),
    selectedTurnId: readString(thread, "selectedTurnId"),
    turnCount: Array.isArray(thread.turns) ? thread.turns.length : 0,
    targetTurnId: turnId,
  };
}

function compactTurn(turn) {
  if (!isRecord(turn)) {
    return undefined;
  }
  const trace = isRecord(turn.trace) ? turn.trace : undefined;
  return compactRecord({
    turnId: readString(turn, "turnId"),
    parentTurnId: readString(turn, "parentTurnId"),
    userMessage: compactMessage(turn.userMessage),
    assistantMessage: compactMessage(turn.assistantMessage),
    trace: compactTrace(trace),
    toolRunCount: Array.isArray(turn.toolRuns) ? turn.toolRuns.length : undefined,
    citationCount: Array.isArray(turn.citations) ? turn.citations.length : undefined,
  });
}

function compactTrace(trace) {
  if (!isRecord(trace)) {
    return undefined;
  }
  return compactRecord({
    turnId: readString(trace, "turnId"),
    sessionId: readString(trace, "sessionId"),
    status: readString(trace, "status"),
    mode: readString(trace, "mode"),
    model: readString(trace, "model"),
    webMode: readString(trace, "webMode"),
    memoryMode: readString(trace, "memoryMode"),
    thinkingLevel: readString(trace, "thinkingLevel"),
    subagentPolicy: readString(trace, "subagentPolicy"),
    startedAt: readString(trace, "startedAt"),
    finishedAt: readString(trace, "finishedAt"),
    failure: trace.failure,
    completion: trace.completion,
    routing: trace.routing,
    durable: trace.durable,
    orchestration: trace.orchestration,
    executionPlanId: readString(trace, "executionPlanId"),
    toolRuns: Array.isArray(trace.toolRuns) ? trace.toolRuns.map(compactToolRun) : [],
    citations: Array.isArray(trace.citations) ? trace.citations.slice(0, 30) : [],
    decisionTraceCount: Array.isArray(trace.decisionTrace) ? trace.decisionTrace.length : 0,
  });
}

function compactToolRun(toolRun) {
  if (!isRecord(toolRun)) {
    return undefined;
  }
  return compactRecord({
    toolRunId: readString(toolRun, "toolRunId"),
    toolName: readString(toolRun, "toolName"),
    status: readString(toolRun, "status"),
    approvalId: readString(toolRun, "approvalId"),
    startedAt: readString(toolRun, "startedAt"),
    finishedAt: readString(toolRun, "finishedAt"),
    error: readString(toolRun, "error"),
    resultSummary: summarizeToolResult(toolRun.result),
  });
}

function compactTree(tree) {
  if (!isRecord(tree)) {
    return undefined;
  }
  return {
    runId: readString(tree, "runId"),
    boardId: readString(tree, "boardId"),
    generatedAt: readString(tree, "generatedAt"),
    nodes: Array.isArray(tree.nodes)
      ? tree.nodes.map((node) =>
          compactRecord({
            id: readString(node, "id"),
            kind: readString(node, "kind"),
            label: readString(node, "label"),
            status: readString(node, "status"),
            parentId: readString(node, "parentId"),
            taskId: readString(node, "taskId"),
            agentSessionId: readString(node, "agentSessionId"),
            summary: readString(node, "summary"),
            metadata: node.metadata,
          }),
        )
      : [],
    edges: Array.isArray(tree.edges) ? tree.edges : [],
    diagnostics: Array.isArray(tree.diagnostics) ? tree.diagnostics : [],
    controls: Array.isArray(tree.controls) ? tree.controls : [],
  };
}

function summarizeToolResult(result) {
  if (!isRecord(result)) {
    return undefined;
  }
  const summary = compactRecord({
    type: readString(result, "type"),
    url: readString(result, "url"),
    title: readString(result, "title"),
    resultCount: Array.isArray(result.results) ? result.results.length : undefined,
    hasLocalBusinessResearch: Boolean(findLocalBusinessAnnotation(result)),
  });
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function findLocalBusinessAnnotation(value) {
  const annotations = [];
  collectLocalBusinessAnnotations(value, annotations);
  return annotations[0];
}

function compactMessage(message) {
  if (!isRecord(message)) {
    return undefined;
  }
  return compactRecord({
    messageId: readString(message, "messageId"),
    role: readString(message, "role"),
    content: truncate(readString(message, "content"), 30_000),
    createdAt: readString(message, "createdAt"),
  });
}

function compactHttpResult(result) {
  return {
    ok: result.ok,
    status: result.status,
    body: compactBody(result.body),
  };
}

function compactBody(body) {
  if (!isRecord(body)) {
    return body;
  }
  return compactRecord({
    ...body,
    assistantMessage: compactMessage(body.assistantMessage),
    trace: compactTrace(body.trace),
  });
}

async function writeArtifactsAndExit(state, artifactDir, exitCode) {
  state.finishedAt = new Date().toISOString();
  state.durationMs = Date.parse(state.finishedAt) - Date.parse(state.startedAt);
  state.blockers = dedupeBlockers(state.blockers);
  state.acceptanceVerdict ??= buildAcceptanceVerdict(state);

  const jsonPath = path.join(artifactDir, "cowork-91303-live-smoke.json");
  const markdownPath = path.join(artifactDir, "cowork-91303-live-smoke.md");
  await writeJson(jsonPath, state);
  await fs.writeFile(markdownPath, renderMarkdownSummary(state, jsonPath), "utf8");

  process.stdout.write(`Cowork 91303 live smoke artifact: ${jsonPath}\n`);
  process.stdout.write(`Cowork 91303 live smoke summary: ${markdownPath}\n`);
  process.stdout.write(`Acceptance verdict: ${state.acceptanceVerdict.status} - ${state.acceptanceVerdict.summary}\n`);
  process.exitCode = exitCode;
}

function renderMarkdownSummary(state, jsonPath) {
  const lines = [
    "# Cowork 91303 Live Smoke",
    "",
    `- Verdict: ${state.acceptanceVerdict?.status ?? "unknown"} - ${state.acceptanceVerdict?.summary ?? ""}`,
    `- Prompt: ${state.prompt}`,
    `- Gateway: ${state.gateway.url ?? "unknown"}`,
    `- Runtime root: ${state.gateway.runtimeRoot ?? "existing gateway"}`,
    `- Session: ${state.session.sessionId ?? "missing"}`,
    `- Turn: ${state.session.turnId ?? "missing"}`,
    `- Agentic run: ${state.session.agenticRunId ?? "missing"}`,
    `- JSON artifact: ${jsonPath}`,
    "",
    "## Final Answer",
    "",
    state.finalAnswer?.trim() ? state.finalAnswer.trim() : "(missing)",
    "",
    "## Child States",
    "",
    ...(state.childStates?.length
      ? state.childStates.map(
          (child) => `- ${child.source}:${child.id ?? child.label ?? "child"} - ${child.status ?? "unknown"}`,
        )
      : ["- (none)"]),
    "",
    "## Local-Business Evidence",
    "",
    `- Annotations: ${state.localBusinessEvidenceSummary?.localBusinessAnnotationCount ?? 0}`,
    `- Candidates: ${state.localBusinessEvidenceSummary?.candidateCount ?? 0}`,
    `- Verified/partial/unverified: ${state.localBusinessEvidenceSummary?.verifiedCandidateCount ?? 0}/${state.localBusinessEvidenceSummary?.partialCandidateCount ?? 0}/${state.localBusinessEvidenceSummary?.unverifiedCandidateCount ?? 0}`,
    `- Candidate emails: ${state.localBusinessEvidenceSummary?.candidateEmailCount ?? 0}`,
    `- Final-answer emails: ${state.localBusinessEvidenceSummary?.finalAnswerEmailCount ?? 0}`,
    `- Source URLs: ${state.localBusinessEvidenceSummary?.sourceUrlCount ?? 0}`,
    "",
    "## Blockers",
    "",
    ...(state.blockers.length
      ? state.blockers.map((blocker) => `- ${blocker.code}: ${blocker.message}`)
      : ["- (none)"]),
    "",
    "## Verdict Reasons",
    "",
    ...(state.acceptanceVerdict?.reasons?.length
      ? state.acceptanceVerdict.reasons.map((reason) => `- ${reason}`)
      : ["- (none)"]),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function prepareRuntimeRoot(runtimeRoot) {
  await fs.mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "workspace"), { recursive: true });
  await copyIfMissing(path.join(repoRoot, "config"), path.join(runtimeRoot, "config"));
  await copyIfMissing(path.join(repoRoot, "skills"), path.join(runtimeRoot, "skills"));
  await copyIfMissing(path.join(repoRoot, "workspaces"), path.join(runtimeRoot, "workspaces"));
}

async function copyIfMissing(source, target) {
  if (!existsSync(source) || existsSync(target)) {
    return;
  }
  await fs.cp(source, target, { recursive: true });
}

async function startGateway({ artifactDir, gatewayMode, port, runtimeRoot }) {
  const stdoutPath = path.join(artifactDir, "diagnostics", "gateway.stdout.log");
  const stderrPath = path.join(artifactDir, "diagnostics", "gateway.stderr.log");
  const stdout = createWriteStream(stdoutPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  const commandArgs =
    gatewayMode === "built"
      ? [process.execPath, path.join(repoRoot, "apps", "gateway", "dist", "main.js")]
      : gatewayMode === "dev"
        ? gatewayDevCommandArgs()
        : gatewaySourceCommandArgs();
  const [command, ...args] = commandArgs;
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      GOATCITADEL_ROOT_DIR: runtimeRoot,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(port),
      GOATCITADEL_AUTH_MODE: "none",
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
      GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
      GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = { child, stdoutPath, stderrPath, spawnError: undefined };
  child.once("error", (error) => {
    handle.spawnError = error;
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  handle.closed = new Promise((resolve) => {
    const finish = () => {
      stdout.end();
      stderr.end();
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
  return handle;
}

async function stopProcess(handle) {
  if (!handle?.child || handle.child.exitCode !== null) {
    await handle?.closed?.catch(() => undefined);
    return;
  }
  if (process.platform === "win32") {
    spawnSync(WINDOWS_CMD, ["/d", "/s", "/c", "taskkill", "/PID", String(handle.child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    handle.child.kill("SIGTERM");
  }
  await Promise.race([handle.closed, delay(12_000)]).catch(() => undefined);
}

async function waitForHealth(gatewayUrl, label, timeoutMs, handle) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle?.spawnError) {
      throw handle.spawnError;
    }
    if (handle?.child?.exitCode !== null) {
      throw new Error(
        `${label} process exited before readiness. stdout: ${handle.stdoutPath} stderr: ${handle.stderrPath}`,
      );
    }
    try {
      const response = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling.
    }
    await delay(1_500);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms at ${gatewayUrl}/health.`);
}

async function requestJson(gatewayUrl, route, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(`${gatewayUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Keep text body.
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

async function resolveAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (!port) {
          reject(new Error("Could not resolve an available port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function removeRuntimeRoot(runtimeRoot) {
  try {
    await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch {
    // The artifact records the root path; cleanup failure should not mask smoke truth.
  }
}

function buildRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function readPositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function readPort(value) {
  const parsed = readPositiveInt(value, "--port");
  if (parsed > 65535) {
    throw new Error("--port must be <= 65535.");
  }
  return parsed;
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function gatewayDevCommandArgs() {
  if (process.platform === "win32") {
    return [WINDOWS_CMD, "/d", "/s", "/c", "pnpm dev:gateway"];
  }
  return [pnpmCommand(), "dev:gateway"];
}

function gatewaySourceCommandArgs() {
  if (process.platform === "win32") {
    return [WINDOWS_CMD, "/d", "/s", "/c", "pnpm --filter @goatcitadel/gateway exec tsx src/main.ts"];
  }
  return [pnpmCommand(), "--filter", "@goatcitadel/gateway", "exec", "tsx", "src/main.ts"];
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value, key) {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

function readNumber(value, key) {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function readNestedString(value, parentKey, key) {
  if (!isRecord(value) || !isRecord(value[parentKey])) {
    return undefined;
  }
  return readString(value[parentKey], key);
}

function compactRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function formatBody(body) {
  return truncate(typeof body === "string" ? body : JSON.stringify(body), 500);
}

function truncate(value, limit) {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function dedupeBlockers(blockers) {
  const seen = new Set();
  const result = [];
  for (const blocker of blockers.filter(Boolean)) {
    const key = `${blocker.code}:${blocker.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(blocker);
  }
  return result;
}

await main();
