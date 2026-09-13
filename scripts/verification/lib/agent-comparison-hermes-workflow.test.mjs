import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import {
  buildNativeComparisonProfile,
  nativeComparisonArguments,
  NATIVE_COMPARISON_PINS,
} from "./agent-comparison-native-profile.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";
import { readNativeComparisonWorkflowEvidence } from "./agent-comparison-goat-evidence.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";
import {
  executeHermesComparisonSkillWorkflow,
  projectHermesComparisonActivation,
  projectHermesComparisonInstructions,
  projectHermesComparisonProposal,
  projectHermesComparisonReuse,
  projectHermesComparisonTurn,
  readHermesComparisonSkillState,
} from "./agent-comparison-hermes-workflow.mjs";

const instructions =
  "---\nname: release-note\ndescription: Release notes from supplied evidence.\n---\n# Inputs\nRead the supplied changes file.\n# Instructions\nUse What changed, Evidence, and Unverified sections.\n# Failure handling\nStop on missing input.\n# Verification\nCheck every output entry against input.\n";
const pending = () => ({
  id: "1234abcd",
  subsystem: "skills",
  action: "create",
  origin: "assistant_tool",
  payload: { action: "create", name: "release-note", content: instructions },
});
const baseline = () => ({
  files: [{ path: "autonomous-ai-agents/hermes-agent/SKILL.md", sha256: sha256("native manual") }],
  pending: [],
  ledger: [],
});
const toolMessages = (name, args, result, sessionId = "source-session") => [
  {
    role: "assistant",
    content: "",
    finish_reason: "tool_calls",
    tool_calls: JSON.stringify([{ id: "native-call", function: { name, arguments: JSON.stringify(args) } }]),
    session_id: sessionId,
  },
  {
    role: "tool",
    content: JSON.stringify(result),
    tool_call_id: "native-call",
    tool_name: name,
    session_id: sessionId,
  },
];
const capture = () => ({
  messages: toolMessages("skill_manage", pending().payload, { success: true, staged: true, pending_id: pending().id }),
});
const proposal = () => projectHermesComparisonProposal({ ...baseline(), pending: [pending()] }, capture());
const activation = (stateDirectory = path.resolve("native-state")) => ({
  stateDirectory,
  proposal: proposal(),
  before: { ...baseline(), pending: [pending()] },
  after: {
    files: [...baseline().files, { path: "release-note/SKILL.md", sha256: proposal().nativeFileSha256 }],
    pending: [],
    ledger: [
      {
        id: "1234abcd5678",
        action: "create",
        actor: "agent",
        skill: "release-note",
        before: [],
        after: [
          { path: path.join(stateDirectory, "skills/release-note/SKILL.md"), sha256: proposal().nativeFileSha256 },
        ],
      },
    ],
  },
});

it("binds a pending skill to its staged native tool call and exact content", () => {
  assert.equal(proposal().instructionsSha256, sha256(instructions));
  for (const change of [
    (state) => {
      state.pending[0].payload.content += "changed";
    },
    (state) => {
      state.pending[0].id = "abcd1234";
    },
    (state) => {
      state.pending[0].payload.category = "elsewhere";
    },
    (state) => {
      state.pending[0].origin = "background_review";
    },
    (state) => {
      state.pending.push(pending());
    },
  ]) {
    const state = { ...baseline(), pending: [pending()] };
    change(state);
    assert.throws(() => projectHermesComparisonProposal(state, capture()));
  }
});

it("distinguishes Windows native file bytes from the universal-newline skill_view text", () => {
  const windows = projectHermesComparisonInstructions(instructions, "win32");
  assert.equal(windows.nativeFileText, instructions.replaceAll("\n", "\r\n"));
  assert.equal(windows.instructions, instructions);
  assert.notEqual(windows.nativeFileSha256, windows.instructionsSha256);
  const posix = projectHermesComparisonInstructions(instructions, "linux");
  assert.equal(posix.nativeFileSha256, posix.instructionsSha256);
  const alreadyCrLf = projectHermesComparisonInstructions("a\r\nb\r", "win32");
  assert.equal(alreadyCrLf.nativeFileText, "a\r\r\nb\r");
  assert.equal(alreadyCrLf.instructions, "a\n\nb\n");
});

it("requires exactly one native ledger mutation and the reviewed installed bytes", () => {
  assert.equal(projectHermesComparisonActivation(activation()).nativeEventId, "1234abcd5678");
  for (const change of [
    (value) => {
      value.after.ledger = [];
    },
    (value) => {
      value.after.files[1].sha256 = sha256("substituted");
    },
    (value) => {
      value.after.ledger[0].after[0].path = path.resolve("outside/SKILL.md");
    },
    (value) => {
      value.after.files.push({ path: "extra/SKILL.md", sha256: sha256("extra") });
    },
    (value) => {
      value.before.pending[0].payload.content += "changed";
    },
    (value) => {
      value.after.pending = [pending()];
    },
  ]) {
    const value = activation();
    change(value);
    assert.throws(() => projectHermesComparisonActivation(value));
  }
});

it("requires settled native messages with unchanged history and exact route and prompt", () => {
  const workspace = path.resolve("fixture-workspace");
  const transcript = {
    status: "retained",
    sessions: [{ id: "source-session", source: "cli", model: "fixture", billing_provider: "custom", cwd: workspace }],
    messages: [
      { id: 1, role: "user", content: "source prompt\n", session_id: "source-session", active: 1 },
      {
        id: 2,
        role: "assistant",
        content: "Finished.",
        finish_reason: "stop",
        session_id: "source-session",
        active: 1,
      },
    ],
  };
  const scope = { prompt: "source prompt", model: "fixture", workspace };
  assert.equal(projectHermesComparisonTurn(transcript, scope).turnId, "hermes-message:1");
  for (const change of [
    (value) => {
      value.messages[0].content = "another task";
    },
    (value) => {
      value.messages[1].finish_reason = "length";
    },
    (value) => {
      value.messages[1].active = 0;
    },
    (value) => {
      value.sessions[0].model = "another-model";
    },
    (value) => {
      value.sessions[0].cwd = path.resolve("outside");
    },
  ]) {
    const value = structuredClone(transcript);
    change(value);
    assert.throws(() => projectHermesComparisonTurn(value, scope));
  }
  assert.throws(() =>
    projectHermesComparisonTurn(transcript, { ...scope, previous: { messages: [{ role: "system" }] } }),
  );
});

it("requires a complete skill_view read in a different session, beyond catalog availability", () => {
  const stateDirectory = path.resolve("native-state");
  const input = {
    sourceSessionId: "source-session",
    proposal: proposal(),
    stateDirectory,
    turn: {
      sessionId: "reuse-session",
      messages: toolMessages(
        "skill_view",
        { name: "release-note" },
        {
          success: true,
          name: "release-note",
          content: instructions,
          _source_path: path.join(stateDirectory, "skills/release-note/SKILL.md"),
        },
        "reuse-session",
      ),
    },
  };
  assert.equal(projectHermesComparisonReuse(input).loadedInstructionsSha256, sha256(instructions));
  for (const change of [
    (value) => {
      value.turn.sessionId = "source-session";
    },
    (value) => {
      value.turn.messages = [];
    },
    (value) => {
      value.turn.messages[1].tool_call_id = "another-call";
    },
    (value) => {
      value.turn.messages[1].content = JSON.stringify({
        success: true,
        name: "release-note",
        content: "already loaded",
      });
    },
  ]) {
    const value = structuredClone(input);
    change(value);
    assert.throws(() => projectHermesComparisonReuse(value));
  }
});

async function fixture(t, { denied = false, substituted = false, extraTurn = false } = {}) {
  const parent = await realpath(tmpdir());
  const cell = await mkdtemp(path.join(parent, "gc-hermes-workflow-"));
  t.after(async () => {
    assert.equal(await realpath(cell), cell);
    assert.equal(path.dirname(cell), parent);
    await rm(cell, { recursive: true, force: true });
  });
  const workspace = path.join(cell, "workspace"),
    evidence = path.join(cell, "evidence"),
    stateDirectory = path.join(cell, "state");
  await mkdir(path.join(workspace, "input"), { recursive: true });
  await mkdir(path.join(evidence, "hermes"), { recursive: true });
  const task = COMPARISON_TASKS.find((entry) => entry.id === "workflow_capture_reuse");
  const profile = {
    revision: NATIVE_COMPARISON_PINS.hermes,
    provider: "comparison",
    model: "fixture",
    tools: ["files", "skills"],
    grants: ["test-workspace"],
    reasoning: "none",
    contextTokens: 64000,
    outputTokens: 8192,
    maxTaskMs: 60000,
  };
  const plan = buildNativeComparisonProfile("hermes", profile, "max_completion_tokens", {
    interactiveCli: true,
    skillWorkflow: true,
  });
  assert.equal(plan.permissionPolicy.files, "host_user");
  assert.equal(plan.permissionPolicy.skills, "review_before_activation");
  const binding = {
    executionId: "hermes-workflow-execution",
    manifestSha256: sha256("manifest"),
    cellId: "hermes:workflow_capture_reuse:1",
    revision: profile.revision,
    effectiveConfigSha256: plan.effectiveConfigSha256,
    fixtureSha256: sha256(task),
  };
  const write = async (name, value) => {
    const bytes = JSON.stringify(value);
    await writeFile(path.join(evidence, name), bytes);
    return { path: name, sha256: sha256(bytes) };
  };
  const launch = await write("native-launch.json", { ...binding, plan });
  await write("session-start.json", {
    ...binding,
    source: "controlled_fixture",
    product: "hermes",
    taskId: task.id,
    profile,
  });
  await write(PERMISSION_REVIEW_FILE, {
    schemaVersion: PERMISSION_REVIEW_VERSION,
    ...binding,
    policy: plan.permissionPolicy,
    reviewedBy: "synthetic fixture",
    reviewedAt: new Date().toISOString(),
    sourceReceipts: [launch],
  });
  for (const [name, text] of Object.entries(task.files)) await writeFile(path.join(workspace, name), text);
  let skills = baseline(),
    sends = 0,
    reviews = 0,
    approvals = 0;
  const transcript = { status: "retained", sessions: [], messages: [] };
  const absent = () => assert.rejects(readFile(path.join(workspace, "input/changes.json")), { code: "ENOENT" });
  const run = async (request) => {
    if (request.action !== "turn" || sends < 2) await absent();
    if (request.action === "review") {
      assert.equal(reviews, 2);
      ++approvals;
      skills = activation(stateDirectory).after;
      if (substituted) skills.files[1].sha256 = sha256("substituted");
      if (extraTurn) transcript.messages.push({ role: "user", content: "unrequested model turn" });
    } else if (request.action === "turn") {
      const sessionId = ++sends === 3 ? "reuse-session" : "source-session";
      assert.equal(request.sessionId, sends === 2 ? "source-session" : undefined);
      if (!transcript.sessions.some((entry) => entry.id === sessionId))
        transcript.sessions.push({
          id: sessionId,
          source: "cli",
          model: "fixture",
          billing_provider: "custom",
          cwd: workspace,
        });
      const messages = [{ role: "user", content: request.prompt }];
      if (sends === 2) {
        skills.pending = [pending()];
        messages.push(...capture().messages);
      } else {
        const reuse = sends === 3;
        if (reuse) {
          assert.equal(approvals, 1);
          messages.push(
            ...toolMessages(
              "skill_view",
              { name: "release-note" },
              {
                success: true,
                name: "release-note",
                content: instructions,
                _source_path: path.join(stateDirectory, "skills/release-note/SKILL.md"),
              },
              sessionId,
            ),
          );
        }
        const data = JSON.parse(
          await readFile(path.join(workspace, reuse ? "input/changes.json" : "input/source-changes.json"), "utf8"),
        );
        await writeFile(
          path.join(workspace, reuse ? "release.md" : "source-release.md"),
          `# What changed\n${data.fixed.join("\n")}\n# Evidence\n${data.evidence.join("\n")}\n# Unverified\n${data.unverified.join("\n")}\n`,
        );
      }
      messages.push({ role: "assistant", content: "Finished.", finish_reason: "stop" });
      for (const entry of messages)
        transcript.messages.push({ ...entry, id: transcript.messages.length + 1, session_id: sessionId, active: 1 });
    }
    return { exitCode: 0, stopReason: "process_exit", cleanupUnconfirmed: false };
  };
  return {
    workspace,
    evidence,
    binding,
    launch,
    absent,
    approvals: () => approvals,
    run: () =>
      executeHermesComparisonSkillWorkflow({
        workspace,
        stateDirectory,
        cellDirectory: cell,
        profile,
        snapshot: async () => structuredClone({ skills, transcript }),
        run,
        retain: (name, value) => write(`hermes/${name}.json`, value),
        onReview: async ({ sha256: digest }) => {
          await absent();
          ++reviews;
          return denied ? "wrong hash" : digest;
        },
      }),
  };
}

it("retains the complete Hermes phase evidence and passes all six independent controlled checks", async (t) => {
  const f = await fixture(t);
  await f.run();
  const summary = await readNativeComparisonWorkflowEvidence({
    product: "hermes",
    evidenceDirectory: f.evidence,
    binding: f.binding,
    source: "controlled_fixture",
  });
  await writeFile(
    path.join(f.evidence, "execution.json"),
    JSON.stringify({ ...summary, nativeReceipts: [...summary.nativeReceipts, f.launch] }),
  );
  const verified = await verifyComparisonEvidence({
    taskId: "workflow_capture_reuse",
    workspaceRoot: f.workspace,
    evidenceRoot: f.evidence,
  });
  assert.equal(verified.outcome, "passed", JSON.stringify(verified.checks));
  assert.equal(verified.evidenceKind, "controlled");
  assert.equal(Object.keys(verified.checks).length, 6);
});

it("withholds reuse input when exact artifact review is declined", async (t) => {
  const f = await fixture(t, { denied: true });
  await assert.rejects(f.run(), /did not review/);
  await f.absent();
  assert.equal(f.approvals(), 0);
});

it("withholds reuse input after substituted installation or a model turn during operator review", async (t) => {
  for (const options of [{ substituted: true }, { extraTurn: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run(), /reviewed bytes|added model turns/);
    await f.absent();
  }
});

it("reads native skill files without treating telemetry as another activation and rejects hard links", async (t) => {
  const parent = await realpath(tmpdir()),
    root = await mkdtemp(path.join(parent, "gc-hermes-state-"));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    assert.equal(path.dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "skills/release-note"), { recursive: true });
  await writeFile(path.join(root, "skills/release-note/SKILL.md"), instructions);
  await writeFile(path.join(root, "skills/.usage.json"), "{}");
  const state = await readHermesComparisonSkillState(root);
  assert.equal(state.files.length, 1);
  assert.equal(state.telemetry.length, 1);
  await link(path.join(root, "skills/release-note/SKILL.md"), path.join(root, "linked.md"));
  await assert.rejects(readHermesComparisonSkillState(root), /ordinary canonical/);
});

it("keeps Hermes skill activation in its explicit terminal profile and binds the native interpreter", () => {
  const profile = {
    revision: NATIVE_COMPARISON_PINS.hermes,
    provider: "comparison",
    model: "fixture",
    tools: ["files", "skills"],
    grants: ["test-workspace"],
    reasoning: "none",
    contextTokens: 64000,
    outputTokens: 1024,
    maxTaskMs: 60000,
  };
  assert.throws(() => buildNativeComparisonProfile("hermes", profile, "max_tokens", { skillWorkflow: true }));
  const plan = buildNativeComparisonProfile("hermes", profile, "max_tokens", {
    skillWorkflow: true,
    interactiveCli: true,
  });
  assert.deepEqual(plan.nativeTools, ["file", "skills"]);
  assert.equal(plan.config.skills.write_approval, true);
  assert.equal(plan.config.skills.ledger, true);
  assert.equal(plan.config.skills.inline_shell, false);
  assert.equal(plan.config.skills.project_discovery, false);
  assert.equal(plan.config.curator.enabled, false);
  const python = path.resolve("native/python.exe");
  const args = nativeComparisonArguments("hermes", {
    skillWorkflow: true,
    executablePath: python,
    checkoutRoot: path.resolve("checkout"),
    configFile: path.resolve("config.yaml"),
    configurationSha256: sha256("config"),
    workspace: path.resolve("workspace"),
    evidenceDirectory: path.resolve("evidence"),
  });
  assert.match(args[0], /agent-comparison-hermes-workflow-child\.mjs$/u);
  assert.equal(args[2], python);
  assert.throws(
    () =>
      buildNativeComparisonProfile("hermes", { ...profile, tools: [...profile.tools, "terminal"] }, "max_tokens", {
        skillWorkflow: true,
        interactiveCli: true,
      }),
    /separate native journey/,
  );
});
