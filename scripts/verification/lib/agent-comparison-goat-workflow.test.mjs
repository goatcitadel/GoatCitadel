import assert from "node:assert/strict";
import { it } from "node:test";
import { PassThrough } from "node:stream";
import {
  hasGoatComparisonSkillActivationEffect,
  projectGoatComparisonSkillActivation,
  projectGoatComparisonSkillReuse,
} from "./agent-comparison-goat-workflow.mjs";
import { createGoatComparisonClient } from "./agent-comparison-goat-client.mjs";
import { executeGoatComparisonTurn } from "./agent-comparison-goat-api.mjs";
import {
  buildNativeComparisonProfile,
  nativeComparisonArguments,
  NATIVE_COMPARISON_PINS,
} from "./agent-comparison-native-profile.mjs";
import {
  createNativeComparisonReviewConsole,
  reviewNativeComparisonArtifact,
} from "./agent-comparison-native-approval-console.mjs";

it("resumes only the exact completed native skill activation effect after approval", () => {
  const identity = { approvalId: "approval-1", candidateId: "candidate-1", versionId: "version-1" };
  const replay = {
    approval: { approvalId: identity.approvalId, status: "approved" },
    effects: [
      {
        effectKind: "capability_lifecycle_apply",
        approvalId: identity.approvalId,
        status: "completed",
        targetKind: "capability_candidate",
        targetId: identity.candidateId,
        idempotencyKey: "approval-1:capability_lifecycle_apply:capability_candidate:candidate-1",
        result: {
          action: "promote",
          candidateId: identity.candidateId,
          selectedVersionId: identity.versionId,
          changedVersionIds: [identity.versionId],
        },
      },
    ],
  };
  assert.equal(hasGoatComparisonSkillActivationEffect(replay, identity), true);
  for (const mutate of [
    (x) => {
      x.approval.status = "pending";
    },
    (x) => {
      x.effects = [];
    },
    (x) => {
      x.effects[0].status = "running";
    },
    (x) => {
      x.effects[0].approvalId = "other";
    },
    (x) => {
      x.effects[0].targetId = "other";
    },
    (x) => {
      x.effects[0].idempotencyKey = "other";
    },
    (x) => {
      x.effects[0].result.selectedVersionId = "other";
    },
    (x) => {
      x.effects[0].result.changedVersionIds.push("other");
    },
    (x) => {
      x.effects.push(structuredClone(x.effects[0]));
    },
  ]) {
    const changed = structuredClone(replay);
    mutate(changed);
    assert.equal(hasGoatComparisonSkillActivationEffect(changed, identity), false);
  }
});

it("binds operator-attributed native history to one approved version and rejects incomplete or differing evidence", () => {
  const identity = { approvalId: "approval-1", candidateId: "candidate-1", versionId: "version-1" };
  const journey = {
    items: [
      {
        eventId: "event-1",
        action: "candidate_promoted",
        actorType: "operator",
        subjectKind: "capability_candidate",
        subjectId: identity.candidateId,
        approvalId: identity.approvalId,
        sourceKind: "capability_candidate_version",
        sourceId: identity.versionId,
        trustDisposition: "approved_capability_mutation",
        summary: {
          selectedVersionId: identity.versionId,
          skillMutationObserved: true,
          callable: true,
          directPromotion: false,
        },
        evidence: { health: "complete", sourceLinked: true, approvalLinked: true },
        evidenceRefs: [
          { owner: "approval", refId: identity.approvalId },
          { owner: "candidate", refId: identity.candidateId },
        ],
      },
    ],
  };
  assert.deepEqual(projectGoatComparisonSkillActivation(journey, identity), journey.items);
  for (const mutate of [
    (x) => {
      x.nextCursor = "more";
    },
    (x) => {
      x.items.push(structuredClone(x.items[0]));
    },
    (x) => {
      x.items[0].approvalId = "other";
    },
    (x) => {
      x.items[0].subjectId = "other";
    },
    (x) => {
      x.items[0].sourceId = "other";
    },
    (x) => {
      x.items[0].summary.directPromotion = true;
    },
    (x) => {
      x.items[0].evidence.approvalLinked = false;
    },
    (x) => {
      x.items[0].evidenceRefs = [];
    },
  ]) {
    const changed = structuredClone(journey);
    mutate(changed);
    assert.throws(() => projectGoatComparisonSkillActivation(changed, identity), /history/);
  }
});

function loadedSkill() {
  return {
    candidateId: "candidate-1",
    versionId: "version-1",
    instructionsSha256: "a".repeat(64),
    workspaceId: "workspace-1",
    sessionId: "session-2",
    turnId: "turn-2",
    envelope: {
      state: "available",
      profile: {
        identity: { workspaceId: "workspace-1", sessionId: "session-2", turnId: "turn-2" },
        selection: {
          trustedSkills: [
            {
              skillId: "reviewed-1",
              capabilityId: "skill:1",
              sourceRef: "candidate:candidate-1:version-1",
              treeSha256: "b".repeat(64),
            },
          ],
          activatedSkills: [
            {
              skillId: "reviewed-1",
              capabilityId: "skill:1",
              treeSha256: "b".repeat(64),
              instructionSha256: "c".repeat(64),
              modules: [{ relativePath: "SKILL.md", sha256: "a".repeat(64) }],
            },
          ],
        },
      },
    },
  };
}
it("binds native loaded modules to the approved candidate without confusing prompt and artifact hashes", () => {
  assert.deepEqual(projectGoatComparisonSkillReuse(loadedSkill()), {
    artifactSha256: "a".repeat(64),
    nativePromptSha256: "c".repeat(64),
  });
  for (const mutate of [
    (x) => {
      x.envelope.profile.identity.sessionId = "source-session";
    },
    (x) => {
      x.envelope.profile.selection.trustedSkills[0].sourceRef = "candidate:candidate-1:other-version";
    },
    (x) => {
      x.envelope.profile.selection.activatedSkills[0].modules[0].sha256 = "d".repeat(64);
    },
    (x) => {
      x.envelope.profile.selection.activatedSkills[0].treeSha256 = "d".repeat(64);
    },
    (x) => {
      x.envelope.profile.selection.activatedSkills.push({ skillId: "unrequested" });
    },
  ]) {
    const input = loadedSkill();
    mutate(input);
    assert.throws(() => projectGoatComparisonSkillReuse(input), /native/);
  }
});

it("keeps skill workflows explicit and product-specific while retaining native permission review", () => {
  const profile = {
    revision: NATIVE_COMPARISON_PINS.goatcitadel,
    provider: "comparison",
    model: "fixture",
    tools: ["files", "skills"],
    grants: ["test-workspace"],
    reasoning: "none",
    contextTokens: 32000,
    outputTokens: 4096,
    maxTaskMs: 120000,
  };
  assert.throws(() => buildNativeComparisonProfile("goatcitadel", profile), /headless/);
  assert.throws(
    () => buildNativeComparisonProfile("goatcitadel", profile, "max_tokens", { skillWorkflow: true }),
    /supervised/,
  );
  assert.throws(
    () => buildNativeComparisonProfile("hermes", profile, "max_tokens", { approvalGateway: true, skillWorkflow: true }),
    /supervised/,
  );
  const plan = buildNativeComparisonProfile("goatcitadel", profile, "max_tokens", {
    approvalGateway: true,
    skillWorkflow: true,
  });
  assert.deepEqual(plan.supportedTasks, ["workflow_capture_reuse"]);
  assert.equal(plan.permissionPolicy.skills, "review_before_activation");
  assert.equal(plan.permissionPolicy.terminal, "disabled");
  assert.ok(
    nativeComparisonArguments("goatcitadel", {
      checkoutRoot: "/source",
      stateDirectory: "/state",
      promptFile: "/prompt",
      workspace: "/workspace",
      evidenceDirectory: "/evidence",
      skillWorkflow: true,
      approvalGateway: true,
    }).includes("--supervised-skill-workflow"),
  );
});

it("refuses changed project/session scope before sending a reused native turn", async () => {
  for (const changed of ["project", "session"]) {
    const requests = [];
    await assert.rejects(
      executeGoatComparisonTurn({
        baseUrl: "http://127.0.0.1:32123/",
        token: "a".repeat(40),
        workspace: "/fixture",
        prompt: "Capture",
        profile: { model: "fixture" },
        nativeScope: { workspaceId: "workspace-1", projectId: "project-1", sessionId: "session-1" },
        retain: async () => {},
        fetchImpl: async (url) => {
          requests.push(url.pathname);
          const items = url.pathname.endsWith("/projects")
            ? [
                {
                  workspaceId: changed === "project" ? "wrong" : "workspace-1",
                  projectId: "project-1",
                  workspacePath: ".",
                },
              ]
            : [{ workspaceId: "workspace-1", projectId: "wrong", sessionId: "session-1" }];
          return new Response(JSON.stringify({ items }));
        },
      }),
      /changed workspace/,
    );
    assert.ok(requests.every((route) => !route.endsWith("/agent-send")));
  }
});

it("rejects API prefix escape and retains failed native responses without retrying", async () => {
  const retained = [],
    calls = [];
  const api = createGoatComparisonClient({
    baseUrl: "http://127.0.0.1:32123/",
    token: "a".repeat(40),
    retain: async (...entry) => retained.push(entry),
    fetchImpl: async (url) => {
      calls.push(url.href);
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    },
  });
  await assert.rejects(api("escape", "/../../elsewhere", {}), /escaped/);
  assert.equal(calls.length, 0);
  await assert.rejects(api("stage", "/skill-captures/stage", {}), /503/);
  assert.equal(calls.length, 1);
  assert.equal(retained[0][1].status, 503);
});

it("requires the exact typed artifact review and cancels when input closes", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = output.isTTY = true;
  output.resume();
  const digest = "a".repeat(64);
  let settled = false;
  const pending = reviewNativeComparisonArtifact(
    { kind: "stage", material: { content: "reviewed" }, sha256: digest },
    { input, output },
  ).then((value) => {
    settled = true;
    return value;
  });
  input.write(`stage ${"b".repeat(64)}\n`);
  await Promise.resolve();
  assert.equal(settled, false);
  input.write(`stage ${digest}\n`);
  assert.equal(await pending, digest);
  input.end();
  output.end();
  const cancelledInput = new PassThrough(),
    cancelledOutput = new PassThrough();
  cancelledInput.isTTY = cancelledOutput.isTTY = true;
  cancelledOutput.resume();
  const cancelled = reviewNativeComparisonArtifact(
    { kind: "confirm", material: {}, sha256: digest },
    { input: cancelledInput, output: cancelledOutput },
  );
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  cancelledInput.end();
  await rejected;
  cancelledOutput.end();
});

it("keeps a single input owner across sequential reviews and rejects overlapping reviews", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = output.isTTY = true;
  output.resume();
  const terminal = createNativeComparisonReviewConsole({ input, output });
  const digest = "a".repeat(64);
  for (const kind of ["stage", "artifacts", "confirm"]) {
    const value = { kind, material: { fixture: true }, sha256: digest };
    const pending = terminal.review(value);
    await assert.rejects(terminal.review(value), /already pending/);
    input.write(`${kind} ${digest}\n`);
    assert.equal(await pending, digest);
    assert.equal(input.isPaused(), false);
    await new Promise((resolve) => globalThis.setImmediate(resolve));
  }
  terminal.stop();
  assert.equal(input.isPaused(), true);
  await assert.rejects(terminal.review({ kind: "stage", material: {}, sha256: digest }), { name: "AbortError" });
  input.end();
  output.end();
});
