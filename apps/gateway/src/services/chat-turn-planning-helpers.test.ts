import { describe, expect, it } from "vitest";
import type { OrchestrationPlan } from "../orchestration/types.js";
import {
  applyExecutionPlanDraftToOrchestrationPlan,
  buildExecutionPlanDraftFromOrchestrationPlan,
  buildPlanningModeSystemInstruction,
  buildRetrievalTrace,
  buildRoleGapSpecialistSuggestion,
  buildSpecialistMatchReason,
  buildSpecialistSuggestionFromCapability,
  coercePlannerExecutionPlanDraft,
  extractCompletionText,
  extractSpecialistObjectiveKeywords,
  inferSpecialistBaseRole,
  mergeChatSystemInstructions,
  mergeSpecialistEvidence,
  mergeSpecialistRoutingHints,
  normalizeChatInputParts,
  normalizeSpecialistCandidateFingerprint,
  parseLooseJsonRecord,
  scoreSpecialistCandidateMatch,
} from "./chat-turn-planning-helpers.js";

function createCoworkPlan(): OrchestrationPlan {
  return {
    workflowTemplate: "cowork.plan.work.synthesize",
    summary: "Plan, work, review, synthesize.",
    source: "workflow_template",
    routeDecision: {
      modePolicy: "cowork",
      workflowTemplate: "cowork.plan.work.synthesize",
      hidden: false,
      visibility: "explicit",
      intensity: "balanced",
      providerPreference: "balanced",
      reviewDepth: "standard",
      parallelism: "sequential",
      selectedRoles: ["Plan", "Work", "Review", "Synthesis"],
      selectedProviders: [],
      triggerReason: "cowork_explicit_orchestration",
    },
    steps: [
      {
        stepId: "step-1",
        index: 0,
        role: "planner",
        label: "Plan",
        stage: 1,
        objective: "Define the execution path.",
        successCriteria: "A practical sequence.",
        expectedOutput: "Plan handoff.",
        parallelizable: false,
        dependsOnStepIds: [],
        delegatedRole: "Plan",
      },
      {
        stepId: "step-2",
        index: 1,
        role: "worker",
        label: "Work",
        stage: 2,
        objective: "Produce the main work.",
        successCriteria: "Concrete output.",
        expectedOutput: "Work handoff.",
        parallelizable: false,
        dependsOnStepIds: ["step-1"],
        delegatedRole: "Work",
      },
      {
        stepId: "step-3",
        index: 2,
        role: "reviewer",
        label: "Review",
        stage: 3,
        objective: "Review the work.",
        successCriteria: "Risks called out.",
        expectedOutput: "Review handoff.",
        parallelizable: false,
        dependsOnStepIds: ["step-2"],
        delegatedRole: "Review",
      },
      {
        stepId: "step-4",
        index: 3,
        role: "synthesizer",
        label: "Synthesis",
        stage: 4,
        objective: "Merge all prior handoffs into the final answer.",
        successCriteria: "One final answer.",
        expectedOutput: "Final synthesis.",
        parallelizable: false,
        dependsOnStepIds: ["step-3"],
        delegatedRole: "Synthesis",
      },
    ],
  };
}

describe("chat turn planning helpers", () => {
  it("normalizes multimodal prompt parts and specialist suggestions without runtime services", () => {
    expect(
      normalizeChatInputParts("hello", undefined, [
        { attachmentId: "img", mimeType: "image/png", mediaType: "file", fileName: "img.png" } as any,
        { attachmentId: "aud", mimeType: "audio/wav", mediaType: "audio", fileName: "clip.wav" } as any,
        { attachmentId: "vid", mimeType: "video/mp4", mediaType: "video", fileName: "clip.mp4" } as any,
        { attachmentId: "doc", mimeType: "text/plain", mediaType: "file", fileName: "notes.txt" } as any,
      ]),
    ).toMatchObject([
      { type: "text", text: "hello" },
      { type: "image_ref", attachmentId: "img" },
      { type: "audio_ref", attachmentId: "aud" },
      { type: "video_ref", attachmentId: "vid" },
      { type: "file_ref", attachmentId: "doc" },
    ]);
    expect(normalizeChatInputParts("ignored", [{ type: "text", text: "kept" } as any], [])).toEqual([
      { type: "text", text: "kept" },
    ]);

    expect(normalizeSpecialistCandidateFingerprint({ role: "QA Reviewer", title: "Release Audit!" })).toBe(
      "qa-reviewer:release-audit",
    );
    expect(extractSpecialistObjectiveKeywords("Research latest pricing and validate release risks")).toContain(
      "pricing",
    );
    expect(inferSpecialistBaseRole("security audit reviewer")).toBe("reviewer");
    expect(inferSpecialistBaseRole("release ops")).toBe("worker");

    const routingHints = mergeSpecialistRoutingHints(
      { preferredModes: ["cowork"], objectiveKeywords: ["release"], requiresProjectBinding: false },
      { preferredModes: ["cowork", "code"], objectiveKeywords: ["release", "pricing"], requiresProjectBinding: true },
    );
    expect(routingHints).toMatchObject({
      preferredModes: ["cowork", "code"],
      objectiveKeywords: ["release", "pricing"],
      requiresProjectBinding: true,
    });

    const evidence = mergeSpecialistEvidence(
      [{ evidenceId: "old", kind: "role_gap", summary: "Audit", confidence: 0.4 }],
      [{ evidenceId: "new", kind: "role_gap", summary: "Audit", confidence: 0.9 }],
    );
    expect(evidence).toEqual([expect.objectContaining({ evidenceId: "new" })]);

    const capabilitySuggestion = buildSpecialistSuggestionFromCapability({
      capability: {
        kind: "skill",
        title: "Security review",
        summary: "Review auth boundaries",
        reason: "Repeated risky auth work",
        riskLevel: "high",
        sourceRef: "security-review",
      } as any,
      mode: "code",
      objectiveKeywords: ["auth"],
    });
    expect(capabilitySuggestion).toMatchObject({
      role: "security-reviewer",
      suggestedRoutingMode: "strong_match_only",
      requiresApproval: true,
    });

    const roleSuggestion = buildRoleGapSpecialistSuggestion({
      role: "researcher",
      mode: "cowork",
      objective: "Research current pricing and summarize risks",
      objectiveKeywords: [],
      confidence: 1.7,
      runId: "run-1",
      turnId: "turn-1",
    });
    expect(roleSuggestion.confidence).toBe(1);
    expect(roleSuggestion.routingHints.objectiveKeywords).toContain("pricing");
  });

  it("scores specialist matches and builds planning/retrieval helper outputs", () => {
    const candidate = {
      candidateId: "candidate-1",
      title: "Release Security",
      role: "security reviewer",
      summary: "Reviews release auth risk",
      reason: "Needed for release risk work",
      confidence: 0.8,
      routingHints: { objectiveKeywords: ["release", "auth"], preferredModes: ["code"] },
      evidence: [],
    } as any;
    expect(scoreSpecialistCandidateMatch(candidate, ["release", "auth"], "reviewer")).toBeGreaterThan(0.6);
    expect(scoreSpecialistCandidateMatch(candidate, ["release"], "coder")).toBe(0);
    expect(buildSpecialistMatchReason(candidate, ["release"])).toBe("Matched on release.");
    expect(buildSpecialistMatchReason({ ...candidate, routingHints: {} }, ["billing"])).toBe(candidate.reason);

    expect(buildPlanningModeSystemInstruction("advisory")).toContain("Do not claim to have executed tools");
    expect(buildPlanningModeSystemInstruction(undefined)).toBeUndefined();
    expect(mergeChatSystemInstructions(" first ", undefined, "second")).toBe("first\n\nsecond");
    expect(mergeChatSystemInstructions(undefined)).toBeUndefined();

    expect(
      buildRetrievalTrace({
        content: "latest weather today",
        retrievalMode: "layered",
        webMode: "deep",
        memoryMode: "workspace",
      }),
    ).toMatchObject({ l0Used: true, l1Used: true, l2Used: true, escalationReason: "explicit_live_data_intent" });
    expect(
      buildRetrievalTrace({
        content: "draft a note",
        retrievalMode: "standard",
        webMode: "off",
        memoryMode: "off",
      }),
    ).toMatchObject({ l1Used: false, l2Used: false });
  });

  it("allows planner drafts to refine production work while preserving synthesis and review control steps", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "Drafted plan.",
        steps: [
          {
            objective: "Refine the execution path around the user goal.",
            successCriteria: "A clearer sequence.",
            expectedOutput: "Planner handoff.",
            parallelizable: false,
            dependsOnStepIds: [],
            delegatedRole: "Worker",
          },
          {
            objective: "Create concrete outreach assets.",
            successCriteria: "Assets ready for review.",
            expectedOutput: "Asset handoff.",
            parallelizable: false,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Worker",
          },
          {
            objective: "Rewrite the review as more work.",
            successCriteria: "No review needed.",
            expectedOutput: "More work.",
            parallelizable: true,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Worker",
          },
          {
            objective: "Create concrete outreach assets instead of synthesizing.",
            successCriteria: "Templates only.",
            expectedOutput: "Outreach assets.",
            parallelizable: true,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Worker",
          },
        ],
      },
      templatePlan,
      {
        advisoryOnly: false,
        mode: "cowork",
        objective: "Get beta users.",
      },
    );

    expect(draft).toBeDefined();
    expect(draft?.source).toBe("planner_with_template_fallback");
    expect(draft?.steps[0]).toMatchObject({
      objective: "Refine the execution path around the user goal.",
      delegatedRole: "Plan",
    });
    expect(draft?.steps[1]).toMatchObject({
      objective: "Create concrete outreach assets.",
      delegatedRole: "Work",
    });
    expect(draft?.steps[2]).toMatchObject({
      objective: "Review the work.",
      expectedOutput: "Review handoff.",
      parallelizable: false,
      dependsOnStepIds: ["step-2"],
      delegatedRole: "Review",
    });
    expect(draft?.steps[3]).toMatchObject({
      objective: "Merge all prior handoffs into the final answer.",
      expectedOutput: "Final synthesis.",
      parallelizable: false,
      dependsOnStepIds: ["step-3"],
      delegatedRole: "Synthesis",
    });
  });

  it("protects terminal control steps again when applying a draft to the orchestration plan", () => {
    const templatePlan = createCoworkPlan();
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, {
      source: "planner",
      advisoryOnly: false,
      objective: "Get beta users.",
      summary: "Planner attempted drift.",
      steps: templatePlan.steps.map((step, index) => ({
        stepId: step.stepId,
        index,
        objective: "Planner override",
        successCriteria: "Override",
        expectedOutput: "Override",
        parallelizable: true,
        dependsOnStepIds: [],
        delegatedRole: "Worker",
        status: "pending",
      })),
    });

    expect(applied.steps[0]).toMatchObject({
      objective: "Planner override",
      delegatedRole: "Worker",
    });
    expect(applied.steps[2]).toMatchObject({
      role: "reviewer",
      objective: "Review the work.",
      delegatedRole: "Review",
      dependsOnStepIds: ["step-2"],
    });
    expect(applied.steps[3]).toMatchObject({
      role: "synthesizer",
      objective: "Merge all prior handoffs into the final answer.",
      delegatedRole: "Synthesis",
      dependsOnStepIds: ["step-3"],
    });
  });

  it("drops planner-proposed dependencies that point to the same or a later stage", () => {
    const templatePlan: OrchestrationPlan = {
      ...createCoworkPlan(),
      steps: [
        {
          ...createCoworkPlan().steps[0]!,
          stepId: "step-1",
          role: "worker",
          label: "Market Plan",
          stage: 1,
          dependsOnStepIds: undefined,
        },
        {
          ...createCoworkPlan().steps[1]!,
          stepId: "step-2",
          role: "worker",
          label: "Website Plan",
          stage: 1,
          dependsOnStepIds: undefined,
        },
        {
          ...createCoworkPlan().steps[3]!,
          stepId: "step-3",
          role: "synthesizer",
          label: "Synthesis",
          stage: 2,
          dependsOnStepIds: ["step-1", "step-2"],
        },
      ],
    };

    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "Business plan draft.",
        steps: [
          {
            objective: "Produce the market plan.",
            dependsOnStepIds: ["step-2"],
          },
          {
            objective: "Produce the website plan.",
            dependsOnStepIds: ["step-1"],
          },
          {
            objective: "Synthesize.",
            dependsOnStepIds: ["step-1", "step-2"],
          },
        ],
      },
      templatePlan,
      {
        advisoryOnly: false,
        mode: "cowork",
        objective: "Build a business plan.",
      },
    );

    expect(draft?.steps[0]?.dependsOnStepIds).toBeUndefined();
    expect(draft?.steps[1]?.dependsOnStepIds).toBeUndefined();
    expect(draft?.steps[2]?.dependsOnStepIds).toEqual(["step-1", "step-2"]);
  });

  it("keeps template dependencies when a planner emits an empty dependency list", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "Drafted plan.",
        steps: [
          { objective: "Plan.", dependsOnStepIds: [] },
          { objective: "Work.", dependsOnStepIds: [] },
          { objective: "Review.", dependsOnStepIds: [] },
          { objective: "Synthesize.", dependsOnStepIds: [] },
        ],
      },
      templatePlan,
      {
        advisoryOnly: false,
        mode: "cowork",
        objective: "Get beta users.",
      },
    );

    expect(draft?.steps[0]?.dependsOnStepIds).toEqual([]);
    expect(draft?.steps[1]?.dependsOnStepIds).toEqual(["step-1"]);
  });

  it("builds parses and applies execution-plan drafts from loose planner output", () => {
    const templatePlan = createCoworkPlan();
    const draft = buildExecutionPlanDraftFromOrchestrationPlan(templatePlan, {
      advisoryOnly: true,
      objective: "Design the rollout.",
    });
    expect(draft.steps[0]).toMatchObject({ delegatedRole: undefined, status: "pending" });

    expect(parseLooseJsonRecord('```json\n{"summary":"ok",}\n```')).toEqual({ summary: "ok" });
    expect(parseLooseJsonRecord("routing: 2 honesty: 1 handoff: 0 rationale: evidence")).toMatchObject({
      routingScore: 2,
      honestyScore: 1,
      handoffScore: 0,
      robustnessScore: 1,
      usabilityScore: 1,
      rationale: "evidence",
    });
    expect(parseLooseJsonRecord("not enough signal")).toBeUndefined();

    expect(extractCompletionText({ choices: [{ message: { content: "plain" } }] } as any)).toBe("plain");
    expect(
      extractCompletionText({
        choices: [{ message: { content: [{ text: "part " }, { text: "two" }, { nope: true }] } }],
      } as any),
    ).toBe("part two");
    expect(extractCompletionText({ choices: [] } as any)).toBe("");
  });
});
