import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { EXECUTION_BINDING_FIELDS, PERMISSION_REVIEW_FILE } from "./agent-comparison-permissions.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { advanceComparisonWorkflow, readComparisonWorkflowInstructions } from "./agent-comparison-workflow.mjs";

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const samePath = (left, right) =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
const skillAuthority = ({ files, pending, ledger }) => ({ files, pending, ledger });
const nativeJson = (text, label) => {
  requireValue(typeof text === "string" && Buffer.byteLength(text) <= 256 * 1024, `Missing bounded ${label}.`);
  return JSON.parse(text);
};

/** Preview the pinned Python text writer and universal-newline reader. The raw
 * artifact and model-loaded instructions have separate hashes on Windows. Both
 * are reviewed; native ledger/file bytes and the actual skill_view result must
 * independently match them. This function never writes the native skill. */
export function projectHermesComparisonInstructions(content, platform = process.platform) {
  requireValue(typeof content === "string" && Buffer.byteLength(content) <= 40_000, "Missing bounded skill content.");
  const nativeFileText = platform === "win32" ? content.replaceAll("\n", "\r\n") : content;
  const instructions = nativeFileText.replace(/\r\n?|\n/gu, "\n");
  return {
    instructions,
    instructionsSha256: sha256(instructions),
    nativeFileText,
    nativeFileSha256: sha256(nativeFileText),
  };
}

/** Native user-message primary keys identify turns in this pinned Hermes schema;
 * the CLI does not provide an OpenClaw-style turn receipt. A stopped successful
 * process plus the complete, settled message segment is required separately. */
export function projectHermesComparisonTurn(transcript, { prompt, model, workspace, previous, sessionId }) {
  requireValue(transcript?.status === "retained", "Retain the stopped native Hermes session database.");
  const oldMessages = previous?.messages ?? [];
  requireValue(
    sha256(transcript.messages.slice(0, oldMessages.length)) === sha256(oldMessages),
    "The native Hermes turn changed previously retained messages.",
  );
  const added = transcript.messages.slice(oldMessages.length);
  const user = added[0];
  const session = transcript.sessions.find((entry) => entry.id === user?.session_id);
  const final = added.at(-1);
  requireValue(
    user?.role === "user" &&
      user.content.trim() === prompt.trim() &&
      added.filter((entry) => entry.role === "user").length === 1 &&
      session?.source === "cli" &&
      session.model === model &&
      session.billing_provider === "custom" &&
      samePath(session.cwd ?? "", workspace) &&
      !session.parent_session_id &&
      (!sessionId || session.id === sessionId) &&
      added.every((entry) => entry.session_id === session.id && entry.active === 1) &&
      final?.role === "assistant" &&
      final.finish_reason === "stop" &&
      !final.tool_calls &&
      typeof final.content === "string" &&
      final.content.trim(),
    "Hermes lacks the exact prompt, route, session, workspace, or settled native turn.",
  );
  const calls = added.flatMap((entry) => (entry.tool_calls ? nativeJson(entry.tool_calls, "native tool calls") : []));
  requireValue(
    calls.every(
      (call) => added.filter((entry) => entry.role === "tool" && entry.tool_call_id === call.id).length === 1,
    ),
    "The native Hermes turn has an unsettled or duplicated tool result.",
  );
  return { sessionId: session.id, turnId: `hermes-message:${user.id}`, messages: added };
}

export function projectHermesComparisonProposal(state, capture) {
  requireValue(state.pending.length === 1, "Capture must leave exactly one native pending skill write.");
  const pending = state.pending[0];
  const payload = pending.payload;
  requireValue(
    /^[a-f0-9]{8}$/u.test(pending.id ?? "") &&
      pending.subsystem === "skills" &&
      pending.action === "create" &&
      pending.origin === "assistant_tool" &&
      payload?.action === "create" &&
      payload.name === "release-note" &&
      !payload.category &&
      !payload.operations &&
      !payload.file_path &&
      !payload.file_content &&
      typeof payload.content === "string" &&
      Buffer.byteLength(payload.content) <= 40_000 &&
      payload.content.startsWith("---"),
    "The native pending skill changed its supported action, name, or instruction artifact.",
  );
  const calls = capture.messages.flatMap((entry) =>
    entry.tool_calls ? nativeJson(entry.tool_calls, "capture calls") : [],
  );
  const writes = calls.filter((entry) => entry.function?.name === "skill_manage");
  requireValue(writes.length === 1, "Capture must use one native skill_manage create operation.");
  const args = nativeJson(writes[0].function.arguments, "capture arguments");
  const result = capture.messages.find((entry) => entry.role === "tool" && entry.tool_call_id === writes[0].id);
  const value = nativeJson(result?.content, "capture result");
  requireValue(
    args.action === "create" &&
      args.name === payload.name &&
      args.content === payload.content &&
      !args.category &&
      !args.operations &&
      result.tool_name === "skill_manage" &&
      value.success === true &&
      value.staged === true &&
      value.pending_id === pending.id,
    "The pending skill is not bound to the native capture turn's staged tool result.",
  );
  const projected = projectHermesComparisonInstructions(payload.content);
  return {
    pendingId: pending.id,
    pendingSha256: sha256(pending),
    ...projected,
    // Hermes does not assign skill versions. This is a content-addressed
    // comparison reference, not a native version identifier or CAS guarantee.
    versionId: `hermes:${pending.id}:${projected.nativeFileSha256}`,
  };
}

export function projectHermesComparisonActivation({ before, after, proposal, stateDirectory }) {
  requireValue(
    before.pending.length === 1 &&
      sha256(before.pending[0]) === proposal.pendingSha256 &&
      after.pending.length === 0 &&
      sha256(after.ledger.slice(0, before.ledger.length)) === sha256(before.ledger),
    "The native pending write or retained mutation history changed before approval.",
  );
  const entries = after.ledger.slice(before.ledger.length);
  const event = entries[0];
  const skillFile = path.join(stateDirectory, "skills/release-note/SKILL.md");
  const installed = after.files.find((entry) => entry.path === "release-note/SKILL.md");
  requireValue(
    entries.length === 1 &&
      /^[a-f0-9]{12}$/u.test(event?.id ?? "") &&
      event.action === "create" &&
      event.skill === "release-note" &&
      event.before?.length === 0 &&
      event.after?.length === 1 &&
      samePath(event.after[0].path, skillFile) &&
      event.after[0].sha256 === proposal.nativeFileSha256 &&
      installed?.sha256 === proposal.nativeFileSha256 &&
      sha256(after.files.filter((entry) => entry !== installed)) === sha256(before.files),
    "Hermes did not retain exactly one native mutation installing the reviewed bytes.",
  );
  return {
    nativeEventId: event.id,
    skillVersionId: proposal.versionId,
    instructionsSha256: proposal.instructionsSha256,
    nativeFileSha256: proposal.nativeFileSha256,
  };
}

export function projectHermesComparisonReuse({ turn, sourceSessionId, proposal, stateDirectory }) {
  requireValue(turn.sessionId !== sourceSessionId, "Reuse requires a new native Hermes session.");
  const calls = turn.messages.flatMap((entry) => (entry.tool_calls ? nativeJson(entry.tool_calls, "reuse calls") : []));
  const reads = calls.filter(
    (call) =>
      call.function?.name === "skill_view" &&
      nativeJson(call.function.arguments, "skill read arguments").name === "release-note",
  );
  const loaded = reads.some((call) => {
    const args = nativeJson(call.function.arguments, "skill read arguments");
    const message = turn.messages.find((entry) => entry.role === "tool" && entry.tool_call_id === call.id);
    const result = nativeJson(message?.content, "skill read result");
    return (
      !args.file_path &&
      message.tool_name === "skill_view" &&
      result.success === true &&
      result.name === "release-note" &&
      typeof result.content === "string" &&
      sha256(result.content) === proposal.instructionsSha256 &&
      samePath(result._source_path ?? "", path.join(stateDirectory, "skills/release-note/SKILL.md"))
    );
  });
  requireValue(loaded, "The new Hermes session did not read the complete reviewed instruction bytes.");
  return { loadedInstructionsSha256: proposal.instructionsSha256 };
}

/** Read only fresh task-owned state, between stopped CLI processes. No native
 * pending record, skill, approval result, or ledger entry is written here. */
export async function readHermesComparisonSkillState(stateDirectory) {
  let count = 0,
    directories = 0,
    bytesRead = 0;
  const ordinary = async (filename, type) => {
    const stat = await lstat(filename);
    requireValue(
      !stat.isSymbolicLink() &&
        (type === "directory" ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
        samePath(await realpath(filename), filename),
      "Hermes evidence requires ordinary canonical paths.",
    );
    return stat;
  };
  await ordinary(stateDirectory, "directory");
  const read = async (filename) => {
    const stat = await ordinary(filename, "file");
    bytesRead += stat.size;
    requireValue(
      ++count <= 256 && stat.size <= 256 * 1024 && bytesRead <= 4 * 1024 * 1024,
      "Native Hermes skill evidence exceeds its inventory or byte bound.",
    );
    const file = await open(filename, "r");
    try {
      const held = await file.stat();
      requireValue(
        held.dev === stat.dev && held.ino === stat.ino && held.size === stat.size,
        "Native Hermes skill evidence changed while opening.",
      );
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.readFile());
    } finally {
      await file.close();
    }
  };
  const children = async (directory) => {
    requireValue(++directories <= 128, "Native Hermes skill directory exceeds its total directory bound.");
    try {
      await ordinary(directory, "directory");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    requireValue(entries.length <= 256, "Native Hermes skill directory exceeds its inventory bound.");
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  };
  const files = [],
    telemetry = [];
  const skillsRoot = path.join(stateDirectory, "skills");
  const visit = async (directory, depth = 0) => {
    requireValue(depth <= 8, "Native Hermes skill directory exceeds its depth bound.");
    for (const entry of await children(directory)) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filename, depth + 1);
        continue;
      }
      const content = await read(filename);
      const relative = path.relative(skillsRoot, filename).replaceAll("\\", "/");
      if ([".curator_ledger.jsonl", ".bundled_manifest", ".usage.json", ".usage.json.lock"].includes(relative)) {
        telemetry.push({ path: relative, sha256: sha256(content), content });
        continue;
      }
      files.push({ path: relative, sha256: sha256(content) });
    }
  };
  await visit(skillsRoot);
  const pending = [];
  for (const entry of await children(path.join(stateDirectory, "pending/skills"))) {
    requireValue(entry.isFile() && /^[a-f0-9]{8}\.json$/u.test(entry.name), "Unexpected native pending skill file.");
    const value = nativeJson(await read(path.join(stateDirectory, "pending/skills", entry.name)), "pending skill");
    requireValue(`${value.id}.json` === entry.name, "The pending skill ID changed filename.");
    pending.push(value);
  }
  let ledger = [];
  try {
    ledger = (await read(path.join(skillsRoot, ".curator_ledger.jsonl")))
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => nativeJson(line, "mutation ledger record"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  requireValue(ledger.length <= 128, "Native Hermes mutation ledger exceeds its record bound.");
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), pending, ledger, telemetry };
}

/** The caller runs the actual native CLI, owns its terminal and process bounds,
 * and snapshots SQLite only after each process is stopped. */
export async function executeHermesComparisonSkillWorkflow({
  run,
  snapshot,
  workspace,
  stateDirectory,
  cellDirectory,
  profile,
  retain,
  onReview,
  signal,
}) {
  const start = await readComparisonJson(path.join(cellDirectory, "evidence/session-start.json"));
  requireValue(
    start.product === "hermes" &&
      start.taskId === "workflow_capture_reuse" &&
      samePath(workspace, path.join(cellDirectory, "workspace")),
    "The Hermes workflow changed cell.",
  );
  const binding = Object.fromEntries(EXECUTION_BINDING_FIELDS.map((key) => [key, start[key]]));
  const sourceKind = start.source === "controlled_fixture" ? "controlled_fixture" : "native_receipts";
  const task = COMPARISON_TASKS.find((entry) => entry.id === start.taskId);
  const records = [];
  let phase = "source",
    sequence = 0;
  const save = async (name, value) => {
    signal?.throwIfAborted();
    requireValue(++sequence <= 128, "Native Hermes workflow exceeds its snapshot bound.");
    await retain(`workflow-${String(sequence).padStart(4, "0")}-${name}`, value);
    records.push({ phase, name, ...value });
  };
  const execute = async (name, request) => {
    await save(`${name}-request`, { request });
    const result = await run(request);
    await save(`${name}-process`, { result });
    requireValue(
      result.exitCode === 0 && result.stopReason === "process_exit" && !result.cleanupUnconfirmed,
      `The native Hermes ${name} process did not finish successfully.`,
    );
    return result;
  };
  const inspect = async (name) => {
    const result = await snapshot();
    await save(name, result);
    return result;
  };
  const review = async (kind, material) => {
    const digest = sha256(material);
    await save(`${kind}-intent`, { kind, material, sha256: digest });
    const decision = await onReview({ kind, material, sha256: digest });
    signal?.throwIfAborted();
    requireValue(decision === digest, "The operator did not review this exact Hermes artifact/action.");
    await save(`${kind}-decision`, { kind, sha256: digest, source: "operator_console", decision: "reviewed" });
  };
  const advance = async (action, details, instructions) => {
    const filename = `native-hermes-workflow-${action}.json`;
    const bytes =
      JSON.stringify(
        { ...binding, source: sourceKind, records: records.filter((entry) => entry.phase === phase) },
        null,
        2,
      ) + "\n";
    requireValue(Buffer.byteLength(bytes) <= 4 * 1024 * 1024, "Hermes phase evidence exceeds its byte bound.");
    const file = await open(path.join(cellDirectory, "evidence", filename), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
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
        permissionReview: {
          path: PERMISSION_REVIEW_FILE,
          sha256: sha256(await readFile(path.join(cellDirectory, "evidence", PERMISSION_REVIEW_FILE))),
        },
      },
    });
  };
  await execute("bootstrap", { action: "bootstrap" });
  const initial = await inspect("initial-state");
  requireValue(
    initial.skills.pending.length === 0 &&
      initial.skills.ledger.length === 0 &&
      initial.skills.files.filter((entry) => entry.path.endsWith("/SKILL.md")).length === 1 &&
      initial.skills.files.some((entry) => entry.path === "autonomous-ai-agents/hermes-agent/SKILL.md") &&
      initial.transcript.messages.length === 0,
    "Start with only Hermes's native essential manual and no task history.",
  );
  await execute("source-turn", { action: "turn", prompt: task.phases[0].prompt });
  const sourced = await inspect("source-state");
  const source = projectHermesComparisonTurn(sourced.transcript, {
    prompt: task.phases[0].prompt,
    model: profile.model,
    workspace,
    previous: initial.transcript,
  });
  requireValue(
    sha256(skillAuthority(initial.skills)) === sha256(skillAuthority(sourced.skills)),
    "The source turn changed the native skill baseline.",
  );
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
  await execute("capture-turn", { action: "turn", prompt: task.phases[1].prompt, sessionId: source.sessionId });
  const captured = await inspect("capture-state");
  const capture = projectHermesComparisonTurn(captured.transcript, {
    prompt: task.phases[1].prompt,
    model: profile.model,
    workspace,
    previous: sourced.transcript,
    sessionId: source.sessionId,
  });
  requireValue(
    sha256(captured.skills.files) === sha256(initial.skills.files) && captured.skills.ledger.length === 0,
    "Capture activated a skill before native operator review.",
  );
  const proposal = projectHermesComparisonProposal(captured.skills, capture);
  await review("artifacts", {
    pending: captured.skills.pending[0],
    instructions: proposal.instructions,
    instructionsSha256: proposal.instructionsSha256,
    nativeFileText: proposal.nativeFileText,
    nativeFileSha256: proposal.nativeFileSha256,
  });
  await review("confirm", {
    nativeCommand: `/skills approve ${proposal.pendingId}`,
    pendingSha256: proposal.pendingSha256,
    instructionsSha256: proposal.instructionsSha256,
    nativeFileSha256: proposal.nativeFileSha256,
    nativeVersionBinding: "pending_id_only_no_expected_hash",
    activation: "native_cli_operator_only",
  });
  const beforeApproval = await inspect("before-approval-state");
  requireValue(
    sha256(skillAuthority(beforeApproval.skills)) === sha256(skillAuthority(captured.skills)),
    "The reviewed native skill changed before approval.",
  );
  await execute("operator-review", { action: "review", sessionId: source.sessionId, pendingId: proposal.pendingId });
  const approved = await inspect("approved-state");
  requireValue(
    sha256(approved.transcript.messages) === sha256(captured.transcript.messages),
    "The operator review session added model turns; retain a native command-only review.",
  );
  const activation = projectHermesComparisonActivation({
    before: captured.skills,
    after: approved.skills,
    proposal,
    stateDirectory,
  });
  await advance(
    "review",
    {
      phase: {
        id: "capture_review",
        sessionId: source.sessionId,
        turnId: capture.turnId,
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
  await execute("reuse-turn", { action: "turn", prompt: task.phases[2].prompt });
  const reused = await inspect("reuse-state");
  const reuse = projectHermesComparisonTurn(reused.transcript, {
    prompt: task.phases[2].prompt,
    model: profile.model,
    workspace,
    previous: approved.transcript,
  });
  const loaded = projectHermesComparisonReuse({
    turn: reuse,
    sourceSessionId: source.sessionId,
    proposal,
    stateDirectory,
  });
  requireValue(
    sha256(skillAuthority(reused.skills)) === sha256(skillAuthority(approved.skills)),
    "Reuse changed the native skill inventory or activation history.",
  );
  await advance("reuse", {
    phase: {
      id: "reuse",
      sessionId: reuse.sessionId,
      turnId: reuse.turnId,
      skillVersionId: proposal.versionId,
      ...loaded,
    },
  });
  return {
    sessionId: reuse.sessionId,
    sourceSessionId: source.sessionId,
    pendingId: proposal.pendingId,
    taskOutcome: "unverified",
  };
}
