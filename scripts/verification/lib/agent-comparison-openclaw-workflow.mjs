import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { EXECUTION_BINDING_FIELDS, PERMISSION_REVIEW_FILE } from "./agent-comparison-permissions.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { advanceComparisonWorkflow, readComparisonWorkflowInstructions } from "./agent-comparison-workflow.mjs";

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Preview the pinned Workshop owner's metadata-only conversion. This is a
 * derived review view, never native execution evidence. After native apply, the
 * installed bytes must match it exactly before the held-out input is released. */
export function projectOpenclawComparisonInstructions(content) {
  requireValue(typeof content === "string" && Buffer.byteLength(content) <= 40_000, "Missing bounded proposal text.");
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(normalized);
  requireValue(match && /^status: proposal$/mu.test(match[1]), "The native proposal has no supported frontmatter.");
  const metadata = match[1]
    .split("\n")
    .filter((line) => !/^(?:status|version|date):/iu.test(line))
    .join("\n")
    .trim();
  requireValue(/^name: "release-note"$/mu.test(metadata), "Review only the declared release-note skill.");
  const result = `---\n${metadata}\n---\n\n${match[2].replace(/^\n+/u, "")}`;
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function projectOpenclawComparisonTurn(result, { sessionKey, model, workspace, expectedSessionId }) {
  const meta = result?.result?.meta;
  const agent = meta?.agentMeta;
  const terminal = agent?.terminalReceipt;
  const prompt = meta?.systemPromptReport;
  requireValue(
    result?.status === "ok" &&
      !meta?.aborted &&
      identifier(result.runId) &&
      identifier(agent?.sessionId) &&
      (!expectedSessionId || agent.sessionId === expectedSessionId) &&
      terminal?.runId === result.runId &&
      terminal.turnId === result.runId &&
      terminal.sessionId === agent.sessionId &&
      terminal.effective?.provider === "comparison" &&
      terminal.effective.model === model &&
      terminal.rerouted === false &&
      prompt?.source === "run" &&
      prompt.sessionKey === sessionKey &&
      prompt.sessionId === agent.sessionId &&
      path.resolve(prompt.workspaceDir ?? "") === path.resolve(workspace) &&
      hash(prompt.systemPrompt?.hash) &&
      Array.isArray(prompt.skills?.entries),
    "The native OpenClaw turn lacks exact terminal, route, workspace, or session evidence.",
  );
  return { sessionId: agent.sessionId, turnId: result.runId, prompt, terminal };
}

export function projectOpenclawComparisonProposal(inspected, { sessionKey, captureTurnId }) {
  const record = inspected?.record;
  requireValue(
    record?.schema === "openclaw.skill-workshop.proposal.v1" &&
      record.kind === "create" &&
      record.status === "pending" &&
      identifier(record.id) &&
      identifier(record.proposedVersion) &&
      record.target?.skillName === "release-note" &&
      record.target.skillKey === "release-note" &&
      record.origin?.agentId === "main" &&
      record.origin.sessionKey === sessionKey &&
      record.origin.runId === captureTurnId &&
      hash(inspected.revisionHash) &&
      !(record.supportFiles?.length || inspected.supportFiles?.length),
    "The captured native proposal changed origin, scope, state, or its supported artifact inventory.",
  );
  const instructions = projectOpenclawComparisonInstructions(inspected.content);
  return {
    proposalId: record.id,
    versionId: `${record.id}:${record.proposedVersion}`,
    revisionHash: inspected.revisionHash,
    instructions,
    instructionsSha256: sha256(instructions),
  };
}

export function projectOpenclawComparisonActivation({ applied, events, installed, proposal, correlationId }) {
  const record = applied?.record;
  const matches = events?.events?.filter((entry) => entry.type === "applied");
  requireValue(
    Array.isArray(events?.events) &&
      events.events.length < 200 &&
      matches.length === 1 &&
      record?.id === proposal.proposalId &&
      record.status === "applied" &&
      `${record.id}:${record.proposedVersion}` === proposal.versionId &&
      matches[0].proposalId === record.id &&
      matches[0].proposedVersion === record.proposedVersion &&
      matches[0].revisionHash === proposal.revisionHash &&
      matches[0].actor?.type === "gateway" &&
      matches[0].correlationId === correlationId &&
      identifier(matches[0].eventId) &&
      matches[0].payload?.targetSkillFile === applied.targetSkillFile &&
      installed?.name === "release-note" &&
      installed.skillKey === "release-note" &&
      typeof installed.content === "string" &&
      sha256(installed.content) === proposal.instructionsSha256,
    "The native Workshop did not retain exactly the reviewed activation and installed instruction bytes.",
  );
  return {
    nativeEventId: matches[0].eventId,
    skillVersionId: proposal.versionId,
    instructionsSha256: proposal.instructionsSha256,
  };
}

export function projectOpenclawComparisonReuse({ history, turn, sourceSessionId, proposal }) {
  requireValue(
    turn.sessionId !== sourceSessionId &&
      history?.sessionId === turn.sessionId &&
      history.hasMore === false &&
      Array.isArray(history.messages) &&
      turn.prompt.skills.entries.length === 1 &&
      turn.prompt.skills.entries[0].name === "release-note" &&
      turn.terminal.successfulToolNames?.includes("skill_workshop"),
    "Reuse lacks a new native session, complete history, or the exact skill selection.",
  );
  const messages = history.messages.map((entry) => entry.message ?? entry);
  const calls = messages
    .filter((entry) => entry.role === "assistant")
    .flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []))
    .filter(
      (entry) =>
        entry.type === "toolCall" &&
        entry.name === "skill_workshop" &&
        entry.arguments?.action === "read" &&
        entry.arguments.skill_name === "release-note",
    );
  const loaded = calls.some((call) =>
    messages.some(
      (entry) =>
        entry.role === "toolResult" &&
        entry.toolCallId === call.id &&
        entry.toolName === "skill_workshop" &&
        entry.isError === false &&
        // Native chat.history omits Workshop read details. Matching the whole
        // returned text proves completeness; an explicit omission still fails.
        entry.details?.contentIncluded !== false &&
        Array.isArray(entry.content) &&
        entry.content.length === 1 &&
        entry.content[0].type === "text" &&
        typeof entry.content[0].text === "string" &&
        sha256(entry.content[0].text) === proposal.instructionsSha256,
    ),
  );
  requireValue(loaded, "The new session did not actually read the complete reviewed Workshop skill.");
  return { loadedInstructionsSha256: proposal.instructionsSha256, nativePromptSha256: turn.prompt.systemPrompt.hash };
}

/** Uses only public native agent/history/Workshop RPCs. The caller owns native
 * client authentication, cancellation, request bounds, and the review terminal. */
export async function executeOpenclawComparisonSkillWorkflow({
  request,
  workspace,
  cellDirectory,
  profile,
  retain,
  onReview,
  signal,
}) {
  requireValue(typeof request === "function" && typeof onReview === "function", "Attach native RPC and review owners.");
  const start = await readComparisonJson(path.join(cellDirectory, "evidence/session-start.json"));
  requireValue(
    start.product === "openclaw" &&
      start.taskId === "workflow_capture_reuse" &&
      path.resolve(workspace) === path.join(path.resolve(cellDirectory), "workspace"),
    "The OpenClaw workflow changed cell.",
  );
  const binding = Object.fromEntries(EXECUTION_BINDING_FIELDS.map((key) => [key, start[key]]));
  const sourceKind = start.source === "controlled_fixture" ? "controlled_fixture" : "native_receipts";
  const task = COMPARISON_TASKS.find((entry) => entry.id === start.taskId);
  const records = [];
  let phase = "source",
    sequence = 0;
  const save = async (name, value) => {
    requireValue(++sequence <= 500, "The native workflow snapshot bound was exceeded.");
    await retain(`workflow-${String(sequence).padStart(4, "0")}-${name}`, value);
    records.push({ phase, name, ...value });
  };
  const api = async (name, method, params, final = false) => {
    signal?.throwIfAborted();
    await save(`${name}-request`, { method, params });
    const result = await request(method, params, { expectFinal: final });
    signal?.throwIfAborted();
    await save(`${name}-response`, { method, result });
    return result;
  };
  const review = async (kind, material) => {
    const digest = sha256(material);
    await save(`${kind}-intent`, { material, sha256: digest, kind });
    const decision = await onReview({ kind, material, sha256: digest });
    signal?.throwIfAborted();
    requireValue(decision === digest, "The operator did not review this exact native artifact/action.");
    await save(`${kind}-decision`, { sha256: digest, kind, source: "operator_console", decision: "reviewed" });
  };
  const advance = async (action, details, instructions) => {
    const filename = `native-openclaw-workflow-${action}.json`;
    const bytes =
      JSON.stringify(
        { ...binding, source: sourceKind, records: records.filter((entry) => entry.phase === phase) },
        null,
        2,
      ) + "\n";
    requireValue(Buffer.byteLength(bytes) <= 4 * 1024 * 1024, "Native phase evidence exceeds its byte bound.");
    const file = await open(path.join(cellDirectory, "evidence", filename), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const permission = await readFile(path.join(cellDirectory, "evidence", PERMISSION_REVIEW_FILE));
    return advanceComparisonWorkflow({
      cellDirectory,
      action,
      instructions,
      executionFile: "workflow-execution.json",
      receipt: {
        ...binding,
        source: sourceKind,
        ...details,
        nativeReceipt: { path: filename, sha256: sha256(bytes) },
        permissionReview: { path: PERMISSION_REVIEW_FILE, sha256: sha256(permission) },
      },
    });
  };
  const send = async (message, sessionKey, expectedSessionId) => {
    const result = await api(
      `${phase}-turn`,
      "agent",
      {
        message,
        agentId: "main",
        sessionKey,
        model: `comparison/${profile.model}`,
        thinking: profile.reasoning === "none" ? "off" : profile.reasoning,
        deliver: false,
        timeout: Math.ceil(profile.maxTaskMs / 1000),
        idempotencyKey: randomUUID(),
        ...(expectedSessionId ? { sessionId: expectedSessionId } : {}),
      },
      true,
    );
    return projectOpenclawComparisonTurn(result, { sessionKey, model: profile.model, workspace, expectedSessionId });
  };
  const inventory = () => api(`${phase}-inventory`, "skills.proposals.list", { agentId: "main" });
  const initial = await inventory();
  requireValue(
    initial.proposals?.length === 0 && initial.installedSkills?.length === 0,
    "Start with an empty native Workshop.",
  );
  const sessionKey = `agent:main:comparison-${randomUUID()}`;
  const source = await send(task.phases[0].prompt, sessionKey);
  requireValue(source.prompt.skills.entries.length === 0, "The source turn unexpectedly loaded a skill.");
  const sourceArtifactSha256 = sha256(
    await readComparisonWorkflowInstructions(path.join(workspace, "source-release.md")),
  );
  await advance("source", {
    phase: {
      id: "source_workflow",
      status: "completed",
      sessionId: source.sessionId,
      turnId: source.turnId,
      sourceArtifactSha256,
    },
  });

  phase = "review";
  const captured = await send(task.phases[1].prompt, sessionKey, source.sessionId);
  const pending = await inventory();
  requireValue(
    pending.proposals?.length === 1 &&
      pending.installedSkills?.length === 0 &&
      captured.prompt.skills.entries.length === 0,
    "Capture must leave exactly one inactive native proposal.",
  );
  const inspected = await api("inspect", "skills.proposals.inspect", {
    agentId: "main",
    proposalId: pending.proposals[0].id,
  });
  const proposal = projectOpenclawComparisonProposal(inspected, { sessionKey, captureTurnId: captured.turnId });
  await review("artifacts", {
    nativeProposal: inspected,
    derivedInstalledInstructions: proposal.instructions,
    instructionsSha256: proposal.instructionsSha256,
  });
  const correlationId = randomUUID();
  const apply = {
    agentId: "main",
    proposalId: proposal.proposalId,
    expectedRevisionHash: proposal.revisionHash,
    correlationId,
    reason: "The comparison operator reviewed this exact skill version and its installed instruction bytes.",
  };
  await review("confirm", {
    method: "skills.proposals.apply",
    params: apply,
    instructionsSha256: proposal.instructionsSha256,
  });
  const applied = await api("apply", "skills.proposals.apply", apply);
  const installed = await api("installed", "skills.workshop.read", { agentId: "main", name: "release-note" });
  const events = await api("activation-events", "skills.proposals.events.list", { agentId: "main", limit: 200 });
  const activation = projectOpenclawComparisonActivation({ applied, installed, events, proposal, correlationId });
  await advance(
    "review",
    {
      phase: {
        id: "capture_review",
        sessionId: source.sessionId,
        turnId: captured.turnId,
        sourceSessionId: source.sessionId,
        sourceTurnId: source.turnId,
        sourceArtifactSha256,
        instructionsSha256: proposal.instructionsSha256,
        reviewedInstructionsSha256: proposal.instructionsSha256,
        reviewDecision: "approved",
        skillVersionId: proposal.versionId,
      },
      activationEvents: [activation],
    },
    proposal.instructions,
  );

  phase = "reuse";
  const reuseKey = `agent:main:comparison-${randomUUID()}`;
  const reused = await send(task.phases[2].prompt, reuseKey);
  const history = await api("reuse-history", "chat.history", {
    agentId: "main",
    sessionKey: reuseKey,
    offset: 0,
    limit: 200,
    maxBytes: 3 * 1024 * 1024,
  });
  const loaded = projectOpenclawComparisonReuse({ history, turn: reused, sourceSessionId: source.sessionId, proposal });
  const final = await inventory();
  requireValue(
    final.proposals?.length === 1 &&
      final.proposals[0].id === proposal.proposalId &&
      final.proposals[0].status === "applied" &&
      final.installedSkills?.length === 1 &&
      final.installedSkills[0].skillKey === "release-note",
    "Reuse changed the native Workshop inventory.",
  );
  const finalEvents = await api("final-events", "skills.proposals.events.list", { agentId: "main", limit: 200 });
  const finalInstalled = await api("final-instructions", "skills.workshop.read", {
    agentId: "main",
    name: "release-note",
  });
  projectOpenclawComparisonActivation({
    applied,
    installed: finalInstalled,
    events: finalEvents,
    proposal,
    correlationId,
  });
  await advance("reuse", {
    phase: {
      id: "reuse",
      sessionId: reused.sessionId,
      turnId: reused.turnId,
      skillVersionId: proposal.versionId,
      ...loaded,
    },
  });
  return {
    sessionId: reused.sessionId,
    sourceSessionId: source.sessionId,
    proposalId: proposal.proposalId,
    taskOutcome: "unverified",
  };
}
