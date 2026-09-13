import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  executeOpenclawComparisonSkillWorkflow,
  projectOpenclawComparisonActivation,
  projectOpenclawComparisonInstructions,
  projectOpenclawComparisonProposal,
  projectOpenclawComparisonReuse,
  projectOpenclawComparisonTurn,
} from "./agent-comparison-openclaw-workflow.mjs";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { readNativeComparisonWorkflowEvidence } from "./agent-comparison-goat-evidence.mjs";
import { buildNativeComparisonProfile, NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";

const instructions = `---\nname: "release-note"\ndescription: "Write checked release notes from a supplied input file."\n---\n\n# Release note\n\n## Inputs\nRead the supplied JSON filename.\n\n## Instructions\nPut fixed entries under What changed, evidence under Evidence, unsupported claims under Unverified.\n\n## Failure handling\nStop on invalid input. Do not invent facts.\n\n## Output\nWrite the requested Markdown filename.\n\n## Verification\nRead the result and check every entry against the input.\n`;
const content = instructions.replace(
  'description: "Write checked release notes from a supplied input file."',
  'description: "Write checked release notes from a supplied input file."\nstatus: proposal\nversion: "v1"\ndate: "2026-09-12"',
);
const proposalInput = () => ({
  record: {
    schema: "openclaw.skill-workshop.proposal.v1",
    kind: "create",
    status: "pending",
    id: "proposal-one",
    proposedVersion: "v1",
    target: { skillName: "release-note", skillKey: "release-note" },
    origin: { agentId: "main", sessionKey: "agent:main:source", runId: "capture-turn" },
  },
  content,
  revisionHash: sha256("exact native revision"),
});
const captureScope = { sessionKey: "agent:main:source", captureTurnId: "capture-turn" };
const proposal = () => projectOpenclawComparisonProposal(proposalInput(), captureScope);
const activated = () => ({
  applied: {
    record: { ...proposalInput().record, status: "applied" },
    targetSkillFile: "/native/workshop/release-note/SKILL.md",
  },
  installed: { name: "release-note", skillKey: "release-note", content: instructions },
  events: {
    events: [
      {
        type: "applied",
        eventId: "event-one",
        proposalId: "proposal-one",
        proposedVersion: "v1",
        revisionHash: proposal().revisionHash,
        actor: { type: "gateway" },
        correlationId: "exact-review",
        payload: { targetSkillFile: "/native/workshop/release-note/SKILL.md" },
      },
    ],
  },
  proposal: proposal(),
  correlationId: "exact-review",
});
const nativeTurn = ({
  runId = "source-turn",
  sessionId = "source-session",
  sessionKey = "agent:main:source",
  workspace = path.resolve("fixture"),
  skills = [],
} = {}) => ({
  runId,
  status: "ok",
  result: {
    meta: {
      aborted: false,
      agentMeta: {
        sessionId,
        terminalReceipt: {
          runId,
          turnId: runId,
          sessionId,
          effective: { provider: "comparison", model: "fixture" },
          rerouted: false,
          successfulToolNames: ["read", "write", "skill_workshop"],
        },
      },
      systemPromptReport: {
        source: "run",
        sessionKey,
        sessionId,
        workspaceDir: workspace,
        systemPrompt: { hash: sha256("native prompt") },
        skills: { entries: skills.map((name) => ({ name })) },
      },
    },
  },
});
const loadedHistory = () => ({
  sessionId: "reuse-session",
  hasMore: false,
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "skill_workshop",
          id: "read-one",
          arguments: { action: "read", skill_name: "release-note" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "read-one",
      toolName: "skill_workshop",
      isError: false,
      content: [{ type: "text", text: instructions }],
    },
  ],
});

it("previews only the supported native proposal and preserves installed bytes", () => {
  assert.equal(projectOpenclawComparisonInstructions(content), instructions);
  assert.equal(projectOpenclawComparisonInstructions(content.replaceAll("\n", "\r\n")), instructions);
  for (const text of [
    content.replace("status: proposal", "status: applied"),
    content.replace("release-note", "another-skill"),
    "x".repeat(40_001),
  ])
    assert.throws(() => projectOpenclawComparisonInstructions(text));
});

it("rejects successful-looking turns with changed native terminal, route, or session identity", () => {
  const scope = {
    sessionKey: "agent:main:source",
    model: "fixture",
    workspace: path.resolve("fixture"),
    expectedSessionId: "source-session",
  };
  assert.equal(projectOpenclawComparisonTurn(nativeTurn(), scope).turnId, "source-turn");
  for (const mutate of [
    (v) => {
      v.status = "error";
    },
    (v) => {
      v.result.meta.aborted = true;
    },
    (v) => {
      v.result.meta.agentMeta.terminalReceipt.turnId = "other";
    },
    (v) => {
      v.result.meta.agentMeta.terminalReceipt.effective.provider = "other";
    },
    (v) => {
      v.result.meta.systemPromptReport.sessionKey = "other";
    },
    (v) => {
      v.result.meta.systemPromptReport.workspaceDir = path.resolve("another-fixture");
    },
  ]) {
    const value = nativeTurn();
    mutate(value);
    assert.throws(() => projectOpenclawComparisonTurn(value, scope));
  }
});

it("requires an inactive native proposal tied to the capture run and supported artifact inventory", () => {
  assert.equal(proposal().instructionsSha256, sha256(instructions));
  for (const mutate of [
    (v) => {
      v.record.status = "applied";
    },
    (v) => {
      v.record.origin.runId = "other";
    },
    (v) => {
      v.record.origin.sessionKey = "other";
    },
    (v) => {
      v.record.supportFiles = [{ path: "script.js" }];
    },
    (v) => {
      v.revisionHash = "invalid";
    },
    (v) => {
      v.record.target.skillKey = "other";
    },
  ]) {
    const value = proposalInput();
    mutate(value);
    assert.throws(() => projectOpenclawComparisonProposal(value, captureScope));
  }
});

it("requires one exact operator activation and unchanged installed instruction bytes", () => {
  assert.equal(projectOpenclawComparisonActivation(activated()).nativeEventId, "event-one");
  for (const mutate of [
    (v) => {
      v.events.events.push({ ...v.events.events[0], eventId: "unexpected" });
    },
    (v) => {
      v.events.events[0].actor.type = "agent";
    },
    (v) => {
      v.events.events[0].correlationId = "other";
    },
    (v) => {
      v.events.events[0].revisionHash = sha256("changed");
    },
    (v) => {
      v.installed.content += "changed";
    },
    (v) => {
      v.applied.record.status = "pending";
    },
  ]) {
    const value = activated();
    mutate(value);
    assert.throws(() => projectOpenclawComparisonActivation(value));
  }
});

it("does not confuse an available skill or truncated tool output with actual reviewed instructions loaded", () => {
  const turn = projectOpenclawComparisonTurn(
    nativeTurn({ runId: "reuse-turn", sessionId: "reuse-session", skills: ["release-note"] }),
    { sessionKey: "agent:main:source", model: "fixture", workspace: path.resolve("fixture") },
  );
  const input = { turn, sourceSessionId: "source-session", proposal: proposal() };
  assert.equal(
    projectOpenclawComparisonReuse({ ...input, history: loadedHistory() }).loadedInstructionsSha256,
    sha256(instructions),
  );
  for (const mutate of [
    (v) => {
      v.messages = [];
    },
    (v) => {
      v.sessionId = "other";
    },
    (v) => {
      v.hasMore = true;
    },
    (v) => {
      v.messages[1].toolCallId = "other";
    },
    (v) => {
      v.messages[1].details = { contentIncluded: false };
    },
    (v) => {
      v.messages[1].content[0].text += "unreviewed";
    },
  ]) {
    const history = loadedHistory();
    mutate(history);
    assert.throws(() => projectOpenclawComparisonReuse({ ...input, history }));
  }
  assert.throws(() =>
    projectOpenclawComparisonReuse({ ...input, sourceSessionId: turn.sessionId, history: loadedHistory() }),
  );
});

async function fixture(t, { rejectReview = false, substituteInstalled = false } = {}) {
  const parent = await realpath(tmpdir());
  const cell = await mkdtemp(path.join(parent, "gc-openclaw-workflow-"));
  t.after(async () => {
    assert.equal(await realpath(cell), cell);
    assert.equal(path.dirname(cell), parent);
    await rm(cell, { recursive: true, force: true });
  });
  const workspace = path.join(cell, "workspace"),
    evidence = path.join(cell, "evidence");
  await mkdir(path.join(workspace, "input"), { recursive: true });
  await mkdir(path.join(evidence, "openclaw"), { recursive: true });
  const task = COMPARISON_TASKS.find((item) => item.id === "workflow_capture_reuse");
  const profile = {
    revision: NATIVE_COMPARISON_PINS.openclaw,
    provider: "comparison",
    model: "fixture",
    tools: ["files", "skills"],
    grants: ["test-workspace"],
    reasoning: "none",
    contextTokens: 64000,
    outputTokens: 8192,
    maxTaskMs: 60000,
  };
  const plan = buildNativeComparisonProfile("openclaw", profile, "max_completion_tokens", {
    approvalGateway: true,
    skillWorkflow: true,
  });
  const binding = {
    executionId: "workflow-execution",
    manifestSha256: sha256("manifest"),
    cellId: "openclaw:workflow_capture_reuse:1",
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
    product: "openclaw",
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
  let sends = 0,
    reviewed = 0,
    applyCount = 0,
    nativeProposal;
  const calls = [];
  const a = activated();
  const absent = () => assert.rejects(readFile(path.join(workspace, "input/changes.json")), { code: "ENOENT" });
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === "agent") {
      ++sends;
      if (sends < 3) await absent();
      if (sends === 2) {
        nativeProposal = proposalInput();
        nativeProposal.record.origin.sessionKey = params.sessionKey;
      } else {
        const reuse = sends === 3;
        if (reuse) {
          assert.equal(applyCount, 1);
          assert.equal(reviewed, 2);
        }
        const data = JSON.parse(
          await readFile(path.join(workspace, reuse ? "input/changes.json" : "input/source-changes.json"), "utf8"),
        );
        await writeFile(
          path.join(workspace, reuse ? "release.md" : "source-release.md"),
          `# What changed\n${data.fixed.join("\n")}\n# Evidence\n${data.evidence.join("\n")}\n# Unverified\n${data.unverified.join("\n")}\n`,
        );
      }
      return nativeTurn({
        runId: sends === 2 ? "capture-turn" : sends === 3 ? "reuse-turn" : "source-turn",
        sessionId: sends === 3 ? "reuse-session" : "source-session",
        sessionKey: params.sessionKey,
        workspace,
        skills: sends === 3 ? ["release-note"] : [],
      });
    }
    if (method === "skills.proposals.list")
      return {
        proposals: nativeProposal ? [{ id: "proposal-one", status: applyCount ? "applied" : "pending" }] : [],
        installedSkills: applyCount ? [{ name: "release-note", skillKey: "release-note" }] : [],
      };
    if (method === "skills.proposals.inspect") return nativeProposal;
    if (method === "skills.proposals.apply") {
      await absent();
      assert.equal(reviewed, 2);
      assert.equal(params.expectedRevisionHash, proposal().revisionHash);
      ++applyCount;
      a.events.events[0].correlationId = params.correlationId;
      return a.applied;
    }
    if (method === "skills.workshop.read")
      return substituteInstalled ? { ...a.installed, content: "substituted" } : a.installed;
    if (method === "skills.proposals.events.list") return a.events;
    if (method === "chat.history") return loadedHistory();
    throw new Error(`Unexpected native method ${method}`);
  };
  return {
    cell,
    workspace,
    evidence,
    binding,
    launch,
    absent,
    calls,
    run: () =>
      executeOpenclawComparisonSkillWorkflow({
        request,
        workspace,
        cellDirectory: cell,
        profile,
        retain: (name, value) => write(`openclaw/${name}.json`, value),
        onReview: async ({ sha256: digest }) => {
          await absent();
          ++reviewed;
          return rejectReview ? "wrong hash" : digest;
        },
      }),
  };
}

it("runs the phased native-owner protocol and independently verifies its bounded synthetic evidence", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.taskOutcome, "unverified");
  const summary = await readNativeComparisonWorkflowEvidence({
    product: "openclaw",
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
  assert.equal(Object.keys(verified.checks).length, 6);
  const sessions = f.calls.filter((entry) => entry.method === "agent").map((entry) => entry.params.sessionKey);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[0], sessions[2]);
  await assert.rejects(
    readNativeComparisonWorkflowEvidence({
      product: "goatcitadel",
      evidenceDirectory: f.evidence,
      binding: f.binding,
      source: "controlled_fixture",
    }),
  );
});

it("does not activate or release held-out input when the operator has not reviewed the exact artifact", async (t) => {
  const f = await fixture(t, { rejectReview: true });
  await assert.rejects(f.run(), /did not review/);
  await f.absent();
  assert.equal(
    f.calls.some((entry) => entry.method === "skills.proposals.apply"),
    false,
  );
});

it("does not release held-out input or reuse substituted installed instructions", async (t) => {
  const f = await fixture(t, { substituteInstalled: true });
  await assert.rejects(f.run(), /reviewed activation/);
  await f.absent();
  assert.equal(f.calls.filter((entry) => entry.method === "agent").length, 2);
});
