import { describe, expect, it } from "vitest";
import type { OrchestrationPlan } from "../orchestration/types.js";
import {
  applyExecutionPlanDraftToOrchestrationPlan,
  deriveStagesFromDependencies,
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

  it("escalates web retrieval per the tuned live-data intent sensitivity (P2-W3)", () => {
    // A non-keyword, memory-on turn: L1 base is 0.78 (>= 0.55), so at the 0.6
    // baseline it must NOT escalate — identical to the historical behaviour.
    const baseline = buildRetrievalTrace({
      content: "summarize the attached document",
      retrievalMode: "layered",
      webMode: "auto",
      memoryMode: "workspace",
    });
    expect(baseline.l2Used).toBe(false);
    expect(baseline.escalationReason).toBeUndefined();

    // Passing the baseline threshold explicitly is byte-identical to omitting it.
    expect(
      buildRetrievalTrace({
        content: "summarize the attached document",
        retrievalMode: "layered",
        webMode: "auto",
        memoryMode: "workspace",
        liveIntentThreshold: 0.6,
      }),
    ).toEqual(baseline);

    // Even at the MAX tuned sensitivity (0.95), an ordinary memory-on turn
    // (L1 base 0.78) must NOT escalate: the escalation cutoff is capped just
    // below 0.78, so tuning sharpens live-intent sensitivity WITHOUT forcing
    // every memory-backed turn onto web/L2 ("always web" regression — finding 4).
    const tuned = buildRetrievalTrace({
      content: "summarize the attached document",
      retrievalMode: "layered",
      webMode: "auto",
      memoryMode: "workspace",
      liveIntentThreshold: 0.95,
    });
    expect(tuned.l2Used).toBe(false);
    expect(tuned.escalationReason).toBeUndefined();

    // The raised sensitivity still bites where intended: a memory-OFF turn has a
    // weak L1 base (0.2) and escalates to L2 at the tuned threshold.
    const tunedWeak = buildRetrievalTrace({
      content: "summarize the attached document",
      retrievalMode: "layered",
      webMode: "auto",
      memoryMode: "off",
      liveIntentThreshold: 0.95,
    });
    expect(tunedWeak.l2Used).toBe(true);
    expect(tunedWeak.escalationReason).toBe("low_retrieval_confidence");

    // The escalation still respects webMode === "off" regardless of sensitivity.
    expect(
      buildRetrievalTrace({
        content: "summarize the attached document",
        retrievalMode: "layered",
        webMode: "off",
        memoryMode: "off",
        liveIntentThreshold: 0.95,
      }).l2Used,
    ).toBe(false);
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

describe("planner-declared fan-out (round-3 R3-7)", () => {
  const expansionInput = {
    advisoryOnly: false,
    mode: "cowork" as const,
    objective: "Research pricing and churn.",
    allowProductionExpansion: true,
  };

  function rawTemplateSteps(templatePlan = createCoworkPlan()) {
    return templatePlan.steps.map((step) => ({
      objective: `${step.objective} (refined)`,
      successCriteria: step.successCriteria,
      expectedOutput: step.expectedOutput,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds,
      delegatedRole: step.delegatedRole,
    }));
  }

  function extraWorker(objective: string, dependsOnStepIds: string[] = ["step-1"], delegatedRole = "Worker") {
    return {
      objective,
      successCriteria: "Complete section.",
      expectedOutput: "Section handoff.",
      parallelizable: true,
      dependsOnStepIds,
      delegatedRole,
    };
  }

  it("drops extra planner steps when expansion is not allowed (legacy behavior)", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), extraWorker("Extra A"), extraWorker("Extra B")] },
      templatePlan,
      { advisoryOnly: false, mode: "cowork", objective: "Research pricing and churn." },
    );
    expect(draft?.steps).toHaveLength(4);
  });

  it("materializes extra parallel workers when expansion is allowed", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [...rawTemplateSteps(templatePlan), extraWorker("Research pricing", ["step-1"], "Pricing")],
      },
      templatePlan,
      expansionInput,
    );
    expect(draft?.steps).toHaveLength(5);
    expect(draft?.steps[4]).toMatchObject({
      stepId: "step-5",
      objective: "Research pricing",
      parallelizable: true,
      dependsOnStepIds: ["step-1"],
      delegatedRole: "Pricing",
      status: "pending",
    });
  });

  it("never expands for chat mode or advisory-only drafts", () => {
    const templatePlan = createCoworkPlan();
    const chatDraft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), extraWorker("Extra")] },
      templatePlan,
      { ...expansionInput, mode: "chat" as const },
    );
    const advisoryDraft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), extraWorker("Extra")] },
      templatePlan,
      { ...expansionInput, advisoryOnly: true },
    );
    expect(chatDraft?.steps).toHaveLength(4);
    expect(advisoryDraft?.steps).toHaveLength(4);
  });

  it("holds the production cap and sanitizes a hostile draft", () => {
    const templatePlan = createCoworkPlan();
    const hostileExtras = Array.from({ length: 40 }, (_, index) =>
      extraWorker(`Extra ${index + 1}`, ["nope-404", "step-1", "step-99"], index % 2 === 0 ? "Synthesis" : ""),
    );
    const draft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), ...hostileExtras] },
      templatePlan,
      expansionInput,
    );
    // Template production = planner + worker (2) ⇒ at most 2 extras materialize.
    expect(draft?.steps).toHaveLength(6);
    for (const extra of draft?.steps.slice(4) ?? []) {
      expect(extra.dependsOnStepIds).toEqual(["step-1"]);
    }
  });

  it("levels stages so independent workers share a stage and control steps follow all production", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [
          ...rawTemplateSteps(templatePlan),
          extraWorker("Research pricing", ["step-1"], "Pricing"),
          extraWorker("Research churn", ["step-1"], "Churn"),
        ],
      },
      templatePlan,
      expansionInput,
    );
    expect(draft?.steps).toHaveLength(6);
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, draft!);

    const byId = new Map(applied.steps.map((step) => [step.stepId, step]));
    expect(applied.steps).toHaveLength(6);
    expect(byId.get("step-1")?.stage).toBe(1);
    expect(byId.get("step-2")?.stage).toBe(2);
    expect(byId.get("step-5")?.stage).toBe(2);
    expect(byId.get("step-6")?.stage).toBe(2);
    expect(byId.get("step-3")?.stage).toBe(3);
    expect(byId.get("step-4")?.stage).toBe(4);
    // Control steps depend on every production step so synthesis can see all
    // fan-out results.
    expect(byId.get("step-3")?.dependsOnStepIds).toEqual(expect.arrayContaining(["step-2", "step-5", "step-6"]));
    expect(byId.get("step-4")?.dependsOnStepIds).toEqual(expect.arrayContaining(["step-3"]));
    // Materialized steps inherit the worker template's execution wiring.
    expect(byId.get("step-5")).toMatchObject({
      role: "worker",
      label: "Pricing",
      delegatedRole: "Pricing",
    });
  });

  it("applies without extras exactly as before when the draft has no expansion", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: rawTemplateSteps(templatePlan) },
      templatePlan,
      expansionInput,
    );
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, draft!);
    expect(applied.steps).toHaveLength(4);
    expect(applied.steps.map((step) => step.stage)).toEqual([1, 2, 3, 4]);
  });
});

describe("deriveStagesFromDependencies", () => {
  it("levels a linear chain", () => {
    expect(
      deriveStagesFromDependencies([
        { stepId: "a", dependsOnStepIds: [] },
        { stepId: "b", dependsOnStepIds: ["a"] },
        { stepId: "c", dependsOnStepIds: ["b"] },
      ]),
    ).toEqual([1, 2, 3]);
  });

  it("levels a diamond so independent middles share a stage", () => {
    expect(
      deriveStagesFromDependencies([
        { stepId: "a", dependsOnStepIds: [] },
        { stepId: "b", dependsOnStepIds: ["a"] },
        { stepId: "c", dependsOnStepIds: ["a"] },
        { stepId: "d", dependsOnStepIds: ["b", "c"] },
      ]),
    ).toEqual([1, 2, 2, 3]);
  });

  it("returns undefined on a cycle", () => {
    expect(
      deriveStagesFromDependencies([
        { stepId: "a", dependsOnStepIds: ["b"] },
        { stepId: "b", dependsOnStepIds: ["a"] },
      ]),
    ).toBeUndefined();
  });

  it("returns undefined on an unknown dependency", () => {
    expect(deriveStagesFromDependencies([{ stepId: "a", dependsOnStepIds: ["ghost"] }])).toBeUndefined();
  });
});

describe("planner fan-out scan bound", () => {
  it("stops scanning garbage extras after the bounded window even when valid entries follow", () => {
    const templatePlan = createCoworkPlan();
    const garbage = Array.from({ length: 30 }, () => ({ objective: "   " }));
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [
          ...templatePlan.steps.map((step) => ({ objective: step.objective })),
          ...garbage,
          {
            objective: "Valid but beyond the scan window",
            parallelizable: true,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Late",
          },
        ],
      },
      templatePlan,
      { advisoryOnly: false, mode: "cowork", objective: "obj", allowProductionExpansion: true },
    );
    // 30 empty entries exceed the scan bound (MAX_PLANNER_PRODUCTION_STEPS * 4
    // = 16), so the late valid entry is never reached.
    expect(draft?.steps).toHaveLength(4);
  });
});
