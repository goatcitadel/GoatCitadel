import { describe, expect, it } from "vitest";
import { deriveCoworkRunViewModel, resolveActiveWorkflowTurn } from "./cowork-view-model";

function makeTurn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: "turn-active",
    userMessage: { content: "Build the operator launch plan with proof." },
    trace: {
      status: "running",
      toolRuns: [],
      startedAt: "2026-05-04T00:00:00.000Z",
      ...overrides,
    },
  } as never;
}

function checkpoint(kind: string, details: Record<string, unknown> = {}) {
  return {
    checkpointId: `checkpoint-${kind}`,
    checkpointKind: kind,
    runId: "run-1",
    planId: "plan-1",
    phaseId: "phase-2",
    waveId: "wave-3",
    details,
    createdAt: "2026-05-04T00:00:00.000Z",
  } as never;
}

function collectDisplayStrings(value: unknown, parentKey = ""): string[] {
  if (parentKey === "raw") {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectDisplayStrings(item, parentKey));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => collectDisplayStrings(item, key));
  }
  return [];
}

describe("deriveCoworkRunViewModel", () => {
  it("surfaces approval waits through the continuation gate and run map", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: {
        turnId: "turn-1",
        userMessage: { content: "Research and patch channel setup." },
        trace: {
          status: "waiting_for_approval",
          toolRuns: [],
          startedAt: "2026-05-04T00:00:00.000Z",
        },
      } as never,
    });

    expect(viewModel.continuationGate.decision).toBe("pause");
    expect(viewModel.continuationGate.reasonCodes).toContain("approval_wait");
    expect(viewModel.runMap.objective).toContain("Research and patch");
    expect(viewModel.stateGaps).toContain("Approval unresolved");
    expect(viewModel.continuationAvailability.available).toBe(false);
  });

  it("does not mark continuation available while an operator gate is paused", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: {
        turnId: "turn-1",
        userMessage: { content: "Research contacts." },
        trace: {
          status: "waiting_for_approval",
          toolRuns: [],
          startedAt: "2026-05-04T00:00:00.000Z",
        },
      } as never,
      agenticRunTree: {
        runId: "orch-approval",
        boardId: "cowork:default",
        generatedAt: "2026-06-22T00:00:00.000Z",
        nodes: [],
        edges: [],
        diagnostics: [],
        controls: [
          {
            action: "retry",
            label: "Continue from gathered evidence",
            enabled: true,
            runtimeEffect: "state_only",
          },
        ],
      },
    });

    expect(viewModel.continuationAvailability).toMatchObject({
      value: "paused",
      available: false,
    });
  });

  it("prefers persisted continuation gate checkpoints when present", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestrationCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          checkpointKind: "continuation_gate",
          runId: "run-1",
          planId: "plan-1",
          details: {
            continuationGate: {
              decision: "checkpoint",
              reasonCodes: ["checkpoint_interval"],
              summary: "Checkpoint required before continuing.",
              metrics: {
                stepsSinceCheckpoint: 8,
                toolRunCount: 3,
                failedToolRunCount: 0,
                retryFailureStreak: 0,
                approvalWait: false,
                userInputWait: false,
                evidenceGapCount: 0,
              },
              recommendedAction: "Review checkpoint.",
              createdAt: "2026-05-04T00:00:00.000Z",
            },
          },
          createdAt: "2026-05-04T00:00:00.000Z",
        },
      ],
    });

    expect(viewModel.continuationGate.decision).toBe("checkpoint");
    expect(viewModel.evidenceSummary.label).toBe("Evidence: checkpoint gate");
    expect(viewModel.runMap.checkpoints[0]?.title).toBe("Continuation gate");
  });

  it("treats a loaded delegation run as linked Cowork state for trace-backed turns", () => {
    const orchestration = {
      runId: "delegation-run-1",
      status: "completed",
      workflowTemplate: "cowork.plan.work.synthesize",
      routeDecision: {
        selectedRoles: ["planner", "worker", "reviewer", "synthesizer"],
      },
      finalSummary: "Launch plan completed.",
    };
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestration: orchestration as never,
      activeTurn: {
        turnId: "turn-1",
        userMessage: { content: "Build a launch plan." },
        trace: {
          status: "running",
          durable: {
            runId: "durable-run-1",
            status: "running",
          },
          orchestration,
          toolRuns: [],
          startedAt: "2026-05-04T00:00:00.000Z",
        },
      } as never,
      delegationRun: {
        runId: "delegation-run-1",
        label: "Launch plan",
        objective: "Build a launch plan.",
        mode: "cowork",
        status: "completed",
        steps: [],
      },
    });

    expect(viewModel.sourceLabel).toBe("Source: delegation run");
    expect(viewModel.completenessLabel).toBe("Completeness: delegation complete");
    expect(viewModel.stageCards.find((item) => item.label === "Execution")?.value).toBe("completed");
    expect(viewModel.stateGaps).not.toContain("Canonical run not loaded");
  });

  it("surfaces partial budgeted delegation runs as continuation work", () => {
    const orchestration = {
      runId: "delegation-run-budget",
      status: "partial",
      workflowTemplate: "cowork.research.synthesize",
      routeDecision: {
        selectedRoles: ["researcher", "synthesizer"],
      },
      finalSummary: undefined,
    };
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestration: orchestration as never,
      activeTurn: {
        turnId: "turn-1",
        userMessage: { content: "Find stores near 91303." },
        trace: {
          status: "completed",
          orchestration,
          toolRuns: [],
          startedAt: "2026-05-04T00:00:00.000Z",
        },
      } as never,
      delegationRun: {
        runId: "delegation-run-budget",
        label: "Store research",
        objective: "Find stores near 91303.",
        mode: "cowork",
        status: "partial",
        stitchedOutput: "Partial output",
        steps: [
          {
            stepId: "delegate-1",
            role: "Researcher",
            label: "Research",
            status: "failed",
            childSessionId: "child-1",
            output: "Strong leads gathered.",
            error: "Tool run budget exceeded for this turn after 7 tool calls.",
            failureGuidance: "Continue from gathered leads.",
          },
        ],
      },
    });

    expect(viewModel.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "delegation-continuation-needed",
          title: "Continuation needed",
        }),
      ]),
    );
    expect(viewModel.nextAction).toMatchObject({
      kind: "retry_turn",
      label: "Continue from gathered leads",
    });
    expect(viewModel.continuationGate.reasonCodes).toContain("delegation_partial");
    expect(viewModel.stateGaps).toContain("Delegation continuation needed");
  });

  it("uses terminal delegation truth over stale canonical running state", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestrationRun: {
        runId: "delegation-run-stale",
        status: "running",
        executionState: "running",
        currentPhaseId: "phase-2",
      } as never,
      activeTurn: makeTurn({
        status: "running",
        durable: {
          status: "running",
        },
      }),
      delegationRun: {
        runId: "delegation-run-stale",
        label: "Store research",
        objective: "Find stores near 91303.",
        mode: "cowork",
        status: "partial",
        stitchedOutput: "Partial output",
        steps: [
          {
            stepId: "delegate-1",
            role: "Researcher",
            status: "failed",
            error: "Repeated tool failure for browser.navigate: Host is not yet allowlisted.",
            failureGuidance: "Continue from gathered leads and use alternate sources.",
          },
        ],
      },
    });

    expect(viewModel.completenessLabel).toBe("Completeness: delegation partial");
    expect(viewModel.stageCards.find((item) => item.label === "Workflow")?.value).toBe("partial");
    expect(viewModel.stageCards.find((item) => item.label === "Execution")?.value).toBe("partial");
    expect(viewModel.now.title).toBe("Chat needs a continuation pass");
    expect(viewModel.continuationGate.reasonCodes).toContain("delegation_partial");
  });

  it("uses linked trace orchestration terminal truth over stale delegation cache", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestrationRun: {
        runId: "delegation-run-stale-cache",
        status: "running",
        executionState: "running",
        currentPhaseId: "phase-2",
      } as never,
      activeTurn: makeTurn({
        status: "partial",
        orchestration: {
          runId: "delegation-run-stale-cache",
          status: "partial",
        },
        durable: {
          status: "completed",
        },
      }),
      delegationRun: {
        runId: "delegation-run-stale-cache",
        label: "Store research",
        objective: "Find stores near 91303.",
        mode: "cowork",
        status: "running",
        stitchedOutput: "Synthesis incomplete",
        steps: [
          {
            stepId: "delegate-1",
            role: "Researcher",
            status: "failed",
            error: "web navigation to the local game-store finder was blocked by the runtime allowlist.",
            failureGuidance: "Continue from gathered leads and use alternate sources.",
          },
        ],
      },
    });

    expect(viewModel.completenessLabel).toBe("Completeness: delegation partial");
    expect(viewModel.stageCards.find((item) => item.label === "Workflow")?.value).toBe("partial");
    expect(viewModel.stageCards.find((item) => item.label === "Execution")?.value).toBe("partial");
    expect(viewModel.outputItems.items[0]).toMatchObject({
      title: "Partial stitched result available",
    });
  });

  it("summarizes optional agentic run-tree diagnostics and controls", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      agenticRunTree: {
        runId: "agentic-run-1",
        generatedAt: "2026-05-04T00:00:00.000Z",
        nodes: [
          {
            id: "root",
            kind: "run",
            label: "Main Cowork run",
            status: "running",
          },
        ],
        edges: [],
        diagnostics: [
          {
            signalId: "signal-1",
            code: "child_timeout",
            severity: "warning",
            title: "Child timed out",
            summary: "A child agent exceeded its runtime budget.",
            createdAt: "2026-05-04T00:00:00.000Z",
          },
        ],
        controls: [
          {
            action: "retry",
            label: "Retry child",
            enabled: true,
            runtimeEffect: "state_only",
            reason: "Records retry intent without replaying commands.",
          },
        ],
      },
    });

    expect(viewModel.agenticRuntime?.runId).toBe("agentic-run-1");
    expect(viewModel.agenticRuntime?.treeNodes[0]?.label).toBe("Main Cowork run");
    expect(viewModel.agenticRuntime?.diagnostics[0]?.title).toBe("Child timed out");
    expect(viewModel.agenticRuntime?.controls[0]?.status).toBe("available");
    expect(viewModel.agenticRuntime?.controls[0]?.meta).toBe("state only");
    expect(viewModel.agenticRuntime?.controls[0]?.note).toBe("Records retry intent without replaying commands.");
  });

  it("exposes verified, partial, and missing local-business contact evidence without raw trace JSON", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: makeTurn({
        status: "partial",
        toolRuns: [
          {
            toolRunId: "tool-local-business",
            status: "executed",
            result: {
              rawTraceJsonCanary: '{"doNotRender":"raw-local-business-json"}',
              localBusinessResearch: {
                kind: "local_business_contact_research",
                plan: {
                  location: "91303",
                  radiusMiles: 10,
                  categories: ["board game and tabletop game store"],
                  requireEmail: true,
                  requireContactName: true,
                },
                candidates: [
                  {
                    storeName: "Guild House",
                    address: "123 Victory Blvd, Canoga Park, CA",
                    website: "https://guild.example",
                    email: "hello@guild.example",
                    contactName: "Morgan",
                    contactRole: "Owner",
                    sourceUrls: ["https://guild.example/contact"],
                    verificationStatus: "verified",
                    blockers: [],
                    evidence: [
                      { url: "https://guild.example/contact", evidenceKind: "address", confidence: "high" },
                      { url: "https://guild.example/contact", evidenceKind: "email", confidence: "high" },
                      { url: "https://guild.example/contact", evidenceKind: "contact_name", confidence: "high" },
                    ],
                  },
                  {
                    storeName: "Game N Grounds",
                    website: "https://gamengrounds.example/contact",
                    sourceUrls: ["https://gamengrounds.example/contact"],
                    verificationStatus: "partial",
                    blockers: ["email_not_verified_from_search_result", "contact_name_not_verified_from_search_result"],
                    evidence: [
                      { url: "https://gamengrounds.example/contact", evidenceKind: "identity", confidence: "medium" },
                      { url: "https://gamengrounds.example/contact", evidenceKind: "address", confidence: "medium" },
                    ],
                  },
                  {
                    storeName: "Dice Cellar",
                    sourceUrls: ["https://listing.example/dice-cellar"],
                    verificationStatus: "unverified",
                    blockers: ["official_source_not_verified"],
                    evidence: [
                      { url: "https://listing.example/dice-cellar", evidenceKind: "listing", confidence: "low" },
                    ],
                  },
                ],
                excluded: [],
                blockers: [],
                verificationNote: "Search snippets are leads only.",
              },
            },
          },
        ],
      }),
    });

    expect(viewModel.contactEvidence?.verified.items[0]).toMatchObject({
      title: "Guild House",
      evidenceStatus: "verified",
    });
    expect(viewModel.contactEvidence?.partial.items[0]).toMatchObject({
      title: "Game N Grounds",
      evidenceStatus: "partial",
      missingFields: expect.arrayContaining(["email", "contact name"]),
    });
    expect(viewModel.contactEvidence?.missing.items.map((item) => item.title)).toEqual(
      expect.arrayContaining(["Game N Grounds: email missing", "Dice Cellar"]),
    );
    expect(viewModel.outputItems.items[0]).toMatchObject({
      id: "local-contact-evidence",
      title: "Local contact evidence",
      status: "missing fields",
      meta: expect.stringContaining("1 verified · 1 partial"),
    });
    expect(viewModel.stateGaps).toContain("Local contact evidence incomplete");
    expect(collectDisplayStrings(viewModel).join("\n")).not.toContain("raw-local-business-json");
  });

  it("reads local-business contact evidence from the canonical agentic tree when parent trace tool runs are empty", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: makeTurn({
        status: "completed",
        toolRuns: [],
      }),
      agenticRunTree: {
        runId: "orch-local-business",
        boardId: "cowork:default",
        generatedAt: "2026-06-22T00:00:00.000Z",
        nodes: [
          {
            id: "subagent:worker",
            kind: "subagent",
            label: "Worker",
            status: "completed",
            metadata: {
              localBusinessResearch: [
                {
                  kind: "local_business_contact_research",
                  workflow: "local_business.research",
                  plan: {
                    location: "91303",
                    radiusMiles: 10,
                    categories: ["board game and tabletop game store"],
                    requireEmail: true,
                    requireContactName: true,
                  },
                  candidates: [
                    {
                      storeName: "BGE's Tabletop",
                      website: "https://bgetabletop.com/",
                      email: "games@boardgamingwitheducation.com",
                      sourceUrls: ["https://bgetabletop.com/"],
                      verificationStatus: "partial",
                      blockers: ["contact_name_not_verified_from_search_result"],
                      evidence: [
                        { url: "https://bgetabletop.com/", evidenceKind: "website", confidence: "medium" },
                        { url: "https://bgetabletop.com/", evidenceKind: "email", confidence: "high" },
                      ],
                    },
                  ],
                  blockers: ["contact_name_not_verified_from_search_result"],
                },
              ],
            },
          },
        ],
        edges: [],
        diagnostics: [],
        controls: [],
      },
    });

    expect(viewModel.contactEvidence?.partial.items[0]).toMatchObject({
      title: "BGE's Tabletop",
      evidenceStatus: "partial",
      sourceUrls: ["https://bgetabletop.com/"],
      missingFields: expect.arrayContaining(["contact name"]),
    });
  });

  it("prefers canonical tree contact evidence over stale trace annotations for the same business", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: makeTurn({
        status: "completed",
        toolRuns: [
          {
            toolRunId: "trace-local-business",
            status: "executed",
            result: {
              localBusinessResearch: {
                kind: "local_business_contact_research",
                workflow: "local_business.research",
                plan: {
                  location: "91303",
                  radiusMiles: 10,
                  categories: ["board game and tabletop game store"],
                  requireEmail: true,
                  requireContactName: true,
                },
                candidates: [
                  {
                    storeName: "BGE's Tabletop",
                    sourceUrls: ["https://bgetabletop.com/"],
                    verificationStatus: "partial",
                    blockers: ["email_not_verified_from_search_result", "contact_name_not_verified_from_search_result"],
                    evidence: [{ url: "https://bgetabletop.com/", evidenceKind: "identity", confidence: "medium" }],
                  },
                ],
              },
            },
          },
        ],
      }),
      agenticRunTree: {
        runId: "orch-local-business",
        boardId: "cowork:default",
        generatedAt: "2026-06-22T00:00:00.000Z",
        nodes: [
          {
            id: "subagent:worker",
            kind: "subagent",
            label: "Worker",
            status: "completed",
            metadata: {
              localBusinessResearch: [
                {
                  kind: "local_business_contact_research",
                  workflow: "local_business.research",
                  plan: {
                    location: "91303",
                    radiusMiles: 10,
                    categories: ["board game and tabletop game store"],
                    requireEmail: true,
                    requireContactName: true,
                  },
                  candidates: [
                    {
                      storeName: "BGE's Tabletop",
                      website: "https://bgetabletop.com/",
                      address: "Canoga Park, CA 91303",
                      email: "games@boardgamingwitheducation.com",
                      contactName: "Jane Manager",
                      sourceUrls: ["https://bgetabletop.com/"],
                      verificationStatus: "verified",
                      blockers: [],
                      evidence: [
                        { url: "https://bgetabletop.com/", evidenceKind: "address", confidence: "medium" },
                        { url: "https://bgetabletop.com/", evidenceKind: "website", confidence: "medium" },
                        { url: "https://bgetabletop.com/", evidenceKind: "email", confidence: "high" },
                        { url: "https://bgetabletop.com/", evidenceKind: "contact_name", confidence: "high" },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
        edges: [],
        diagnostics: [],
        controls: [],
      },
    });

    expect(viewModel.contactEvidence?.verified.items[0]).toMatchObject({
      title: "BGE's Tabletop",
      evidenceStatus: "verified",
      email: "games@boardgamingwitheducation.com",
      contactName: "Jane Manager",
    });
    expect(viewModel.contactEvidence?.partial.items.map((item) => item.title)).not.toContain("BGE's Tabletop");
  });

  it("does not downgrade runtime-verified local-business candidates with no blockers", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: makeTurn({
        status: "completed",
        toolRuns: [
          {
            toolRunId: "tool-verified-local-business",
            status: "executed",
            result: {
              localBusinessResearch: {
                kind: "local_business_contact_research",
                plan: {
                  location: "91303",
                  radiusMiles: 10,
                  categories: ["board game and tabletop game store"],
                  requireEmail: false,
                  requireContactName: false,
                },
                candidates: [
                  {
                    storeName: "Source Verified Games",
                    address: "Canoga Park, CA",
                    sourceUrls: ["https://locator.example/source-verified-games"],
                    verificationStatus: "verified",
                    blockers: [],
                    evidence: [
                      { url: "https://locator.example/source-verified-games", evidenceKind: "identity" },
                      { url: "https://locator.example/source-verified-games", evidenceKind: "address" },
                    ],
                  },
                ],
                excluded: [],
                blockers: [],
              },
            },
          },
        ],
      }),
    });

    expect(viewModel.contactEvidence?.verified.items[0]).toMatchObject({
      title: "Source Verified Games",
      evidenceStatus: "verified",
      missingFields: [],
    });
    expect(viewModel.contactEvidence?.missing.items.map((item) => item.title)).not.toContain(
      "Source Verified Games: official website missing",
    );
    expect(viewModel.stateGaps).not.toContain("Local contact evidence incomplete");
  });

  it("surfaces source-backed local-business blockers and research diagnostics", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: makeTurn({
        toolRuns: [
          {
            toolRunId: "tool-source-blockers",
            status: "executed",
            result: {
              localBusinessResearch: {
                kind: "local_business_contact_research",
                plan: {
                  location: "91303",
                  radiusMiles: 10,
                  categories: ["board game and tabletop game store"],
                  requireEmail: true,
                  requireContactName: true,
                },
                candidates: [
                  {
                    storeName: "Game N Grounds",
                    website: "https://gamengrounds.example/contact",
                    sourceUrls: ["https://gamengrounds.example/contact"],
                    verificationStatus: "partial",
                    blockers: ["email_not_verified_from_search_result"],
                    evidence: [
                      { url: "https://gamengrounds.example/contact", evidenceKind: "identity", confidence: "medium" },
                    ],
                  },
                ],
                excluded: [
                  {
                    reason: "blocked_or_secondary_listing_source",
                    sourceUrl: "https://www.yelp.com/search?find_desc=board+game+stores&find_loc=91303",
                    title: "Board Game Stores near Canoga Park - Yelp",
                  },
                ],
                blockers: ["Yelp returned 403"],
                verificationNote: "Blocked listing sites are not verified contact evidence.",
              },
            },
          },
        ],
      }),
    });

    expect(viewModel.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining("research-source-blocker"),
          sourceLabel: "Browser fallback chain",
          summary: expect.stringContaining("Yelp returned 403"),
        }),
        expect.objectContaining({
          id: expect.stringContaining("research-excluded-source"),
          sourceLabel: "Local-business source filter",
          sourceUrls: ["https://www.yelp.com/search?find_desc=board+game+stores&find_loc=91303"],
        }),
        expect.objectContaining({
          id: expect.stringContaining("contact-evidence-blocker"),
          sourceLabel: "Local-business contact evidence",
          sourceUrls: ["https://gamengrounds.example/contact"],
        }),
      ]),
    );
    expect(viewModel.researchDiagnostics.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Local-business research plan", status: "source-backed" }),
        expect.objectContaining({ title: "Search evidence diagnostics", status: "leads found" }),
        expect.objectContaining({ title: "Excluded source: Board Game Stores near Canoga Park - Yelp" }),
      ]),
    );
    expect(viewModel.outputItems.items.find((item) => item.id === "research-diagnostics")).toMatchObject({
      status: "blocked sources",
    });
  });

  it("prefers canonical agentic tree child progress over stale plan and delegation projections", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      executionPlan: {
        objective: "Find local contacts.",
        steps: [
          {
            stepId: "stale-plan",
            objective: "Stale plan node",
            status: "running",
            parallelizable: true,
          },
        ],
      } as never,
      delegationRun: {
        runId: "run-tree",
        label: "Stale delegation",
        objective: "Find local contacts.",
        mode: "cowork",
        status: "running",
        steps: [
          {
            stepId: "stale-delegation",
            role: "Researcher",
            status: "running",
            childSessionId: "stale-child",
          },
        ],
      },
      agenticRunTree: {
        runId: "run-tree",
        generatedAt: "2026-05-04T00:00:00.000Z",
        nodes: [
          { id: "run:run-tree", kind: "run", label: "Canonical run", status: "running" },
          {
            id: "subagent:canonical-research",
            kind: "subagent",
            label: "Canonical researcher",
            status: "completed",
            parentId: "run:run-tree",
            summary: "Verified source leads and missing contact fields.",
            metadata: {
              role: "Researcher",
              childSessionId: "child-canonical",
              childTraceStatus: "completed",
              durableRunId: "durable-canonical",
            },
          },
        ],
        edges: [{ from: "run:run-tree", to: "subagent:canonical-research", kind: "spawned" }],
        diagnostics: [
          {
            signalId: "diag-canonical",
            code: "projection_status_drift",
            severity: "warning",
            title: "Projection reconciled",
            summary: "Delegation state was reconciled from child runtime evidence.",
            evidenceRef: "chat-turn:child-canonical",
            createdAt: "2026-05-04T00:00:00.000Z",
          },
        ],
        controls: [
          {
            action: "retry",
            label: "Continue child",
            enabled: true,
            runtimeEffect: "state_only",
          },
        ],
      },
    });

    expect(viewModel.runMap.planNodes[0]).toMatchObject({
      id: "agentic-subagent:canonical-research",
      label: "Canonical researcher",
      status: "completed",
      meta: "Researcher",
    });
    expect(viewModel.roleItems.items[0]).toMatchObject({
      id: "agentic-child-subagent:canonical-research",
      title: "Canonical researcher",
      meta: "Researcher · trace completed · session child-canonical · durable durable-canonical",
    });
    expect(viewModel.childProgressItems.items[0]?.title).toBe("Canonical researcher");
    expect(viewModel.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agentic-diagnostic-blocker-diag-canonical",
          sourceLabel: "Agentic runtime diagnostic",
          summary: expect.stringContaining("Evidence: chat-turn:child-canonical"),
        }),
      ]),
    );
    expect(viewModel.continuationAvailability).toMatchObject({
      value: "available",
      available: true,
    });
  });

  it("renders canonical waiting reason and child turn provenance from the agentic run tree", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      agenticRunTree: {
        runId: "run-waiting-tree",
        generatedAt: "2026-07-11T00:00:00.000Z",
        nodes: [
          { id: "run:run-waiting-tree", kind: "run", label: "Waiting run", status: "running" },
          {
            id: "subagent:waiting-researcher",
            kind: "subagent",
            label: "Waiting researcher",
            status: "paused",
            parentId: "run:run-waiting-tree",
            agentSessionId: "child-waiting-tree",
            summary: "Approve read access to the project workspace.",
            metadata: {
              role: "researcher",
              childTraceStatus: "waiting_for_approval",
              childSessionId: "child-waiting-tree",
              childTurnId: "turn-waiting-tree",
              durableRunId: "durable-waiting-tree",
              waitObservedAt: "2026-07-11T00:00:00.000Z",
            },
          },
        ],
        edges: [{ from: "run:run-waiting-tree", to: "subagent:waiting-researcher", kind: "spawned" }],
        diagnostics: [],
        controls: [],
      },
    });

    expect(viewModel.childProgressItems.items[0]).toMatchObject({
      title: "Waiting researcher",
      status: "paused",
      meta: "researcher · trace waiting for approval · session child-waiting-tree · turn turn-waiting-tree · durable durable-waiting-tree",
      note: "Approve read access to the project workspace.",
    });
  });

  it("returns a pre-run board and resolves active workflow turns", () => {
    const empty = deriveCoworkRunViewModel({ items: [] });

    expect(empty.empty).toBe(true);
    expect(empty.nextAction?.kind).toBe("focus_composer");
    expect(empty.now.title).toBe("No agentic Chat run is active yet");
    expect(empty.runMap.planNodes.map((node) => node.id)).toEqual(["plan", "research", "patch", "qa", "ship"]);
    expect(resolveActiveWorkflowTurn(null)).toBeNull();
    expect(
      resolveActiveWorkflowTurn({
        activeLeafTurnId: "turn-2",
        turns: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
      } as never),
    ).toEqual({ turnId: "turn-2" });
    expect(
      resolveActiveWorkflowTurn({
        turns: [{ turnId: "turn-1" }, { turnId: "turn-last" }],
      } as never),
    ).toEqual({ turnId: "turn-last" });
  });

  it("summarizes canonical run state, execution plans, checkpoints, outputs, and overflow", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [
        { id: "task-1", title: "Review task 1", note: "one" },
        { id: "task-2", title: "Review task 2", note: "two" },
        { id: "task-3", title: "Review task 3", note: "three" },
        { id: "task-4", title: "Review task 4", note: "four" },
      ],
      orchestration: {
        runId: "run-1",
        status: "running",
        objective:
          "Coordinate release hardening across the repo with a very long explanation that should be truncated in the run map objective because it is too verbose to display in the compact board.",
        workflowTemplate: "cowork.release",
        routeDecision: { selectedRoles: ["planner", "worker"] },
        steps: [
          {
            stepId: "role-1",
            role: "Planner",
            label: "Planning",
            status: "running",
            providerId: "openai",
            model: "gpt-5.5",
            summary: "Create a plan.",
          },
        ],
      } as never,
      orchestrationRun: {
        runId: "run-1",
        status: "completed",
        executionState: "worktree_ready",
        currentPhaseId: "phase-2",
        currentWaveId: "wave-3",
        worktreeStatus: "ready",
      } as never,
      orchestrationCheckpoints: [
        checkpoint("run_started", { lifecycleState: "running" }),
        checkpoint("phase_executed", { error: "Phase output was incomplete and needs review." }),
      ],
      executionPlan: {
        objective: "Ship release hardening",
        steps: [
          {
            stepId: "plan-1",
            objective: "Plan the work",
            status: "completed",
            delegatedRole: "Architect",
            dependsOnStepIds: ["seed"],
            summary: "Planning complete.",
          },
          {
            stepId: "plan-2",
            objective: "Patch the work",
            status: "running",
            successCriteria: "Tests pass.",
          },
          {
            stepId: "plan-3",
            objective: "Review the work",
            status: "pending",
            error: "Waiting on patches.",
          },
          {
            stepId: "plan-4",
            objective: "Ship the work",
            status: "pending",
          },
        ],
      } as never,
      activeTurn: makeTurn({
        durable: { workerHealth: "healthy" },
        toolRuns: [{ status: "completed" }],
      }),
      selectedTurn: {
        turnId: "turn-historical",
        userMessage: { content: "old" },
        trace: { status: "completed", toolRuns: [] },
      } as never,
      workbenchState: { worktreeStatus: "ready", validationStatus: "failed" } as never,
    });

    expect(viewModel.sourceLabel).toBe("Source: canonical run");
    expect(viewModel.now.summary).toBe("Phase 2 · Wave 3 · worktree ready.");
    expect(viewModel.now.facts).toEqual(
      expect.arrayContaining([
        { label: "Workflow", value: "cowork.release" },
        { label: "Roles", value: "planner -> worker" },
        { label: "Durable worker", value: "healthy" },
      ]),
    );
    expect(viewModel.operatorActionItems.overflow).toBe(1);
    expect(viewModel.planItems.overflow).toBe(1);
    expect(viewModel.planItems.items[0]?.meta).toBe("Role Architect · Depends on seed");
    expect(viewModel.roleItems.items[0]?.meta).toBe("openai · gpt-5.5");
    expect(viewModel.timelineItems.items[0]?.title).toBe("Phase completed");
    expect(viewModel.timelineItems.items[0]?.meta).toBe("Phase 2 · Wave 3");
    expect(viewModel.outputItems.items[0]?.title).toBe("Worktree ready");
    expect(viewModel.stateGaps).toContain("Manual UI proof not attached");
    expect(viewModel.evidenceSummary.detail).toContain("1 tool call");
    expect(viewModel.selectionLabel).toContain("Selected historical turn");
    expect(viewModel.runMap.planNodes[0]).toEqual(
      expect.objectContaining({ id: "plan-1", label: "Plan the work", status: "completed" }),
    );
  });

  it("marks degraded handoff sources and synthesizers in role items", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestration: {
        runId: "run-degraded",
        status: "partial",
        objective: "Synthesize a degraded research handoff.",
        workflowTemplate: "cowork.research",
        routeDecision: { selectedRoles: ["researcher", "synthesizer"] },
        steps: [
          {
            stepId: "research-1",
            role: "Researcher",
            label: "Research",
            status: "failed",
            output: "Useful source notes were gathered before failure.",
            summary: "Research failed after gathering evidence.",
          },
          {
            stepId: "synth-1",
            role: "Synthesizer",
            label: "Synthesis",
            status: "completed",
            summary: "Final answer synthesized.",
            degradedHandoffStepIds: ["research-1"],
          },
          {
            stepId: "critic-1",
            role: "Critic",
            label: "Critique",
            status: "completed",
            summary: "Critique of degraded research.",
            degradedHandoffStepIds: ["research-1"],
          },
        ],
      } as never,
    });

    expect(viewModel.roleItems.items[0]).toMatchObject({
      id: "role-research-1",
      tone: "warning",
    });
    expect(viewModel.roleItems.items[0]?.note).toContain("Used by downstream synthesis despite failed status.");
    expect(viewModel.roleItems.items[1]).toMatchObject({
      id: "role-synth-1",
      tone: "warning",
    });
    expect(viewModel.roleItems.items[1]?.note).toContain("Synthesized from 1 failed-but-usable upstream handoff.");
    expect(viewModel.roleItems.items[2]).toMatchObject({
      id: "role-critic-1",
      tone: "warning",
    });
    expect(viewModel.roleItems.items[2]?.note).toContain("Worked from 1 failed-but-usable upstream handoff.");
  });

  it("prioritizes user input blockers, durable recovery, delegation failures, and trace fallback", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestration: {
        runId: "run-trace",
        status: "running",
        objective: "Trace fallback objective",
        workflowTemplate: "cowork.trace",
        routeDecision: { selectedRoles: [] },
        steps: [
          {
            stepId: "role-1",
            role: "Researcher",
            status: "failed",
            error: "Role failed with a long failure summary that should be normalized for display.",
          },
        ],
      } as never,
      orchestrationError: "Could not refresh run state",
      activeTurn: makeTurn({
        status: "waiting_for_user_input",
        durable: { recoveryState: "checkpoint_stale", recoverySummary: "Checkpoint needs replay." },
        toolRuns: [{ status: "failed" }, { status: "failed" }],
      }),
      delegationRun: {
        runId: "other-run",
        label: "Delegated work",
        objective: "Delegate",
        mode: "parallel",
        status: "running",
        stitchedOutput: "Combined output",
        steps: [
          {
            stepId: "delegate-1",
            role: "Reviewer",
            label: "Review",
            status: "failed",
            childSessionId: "child-1",
            output: "Partial output",
            error: "Reviewer failed.",
          },
        ],
      },
      workbenchState: { worktreeStatus: "dirty", validationStatus: "passed" } as never,
      orchestrationCheckpoints: [checkpoint("run_started"), checkpoint("run_resumed"), checkpoint("wave_advanced")],
    });

    expect(viewModel.sourceLabel).toBe("Source: trace fallback");
    expect(viewModel.freshnessLabel).toBe("Freshness: partially refreshed");
    expect(viewModel.completenessLabel).toBe("Completeness: partial");
    expect(viewModel.nextAction?.kind).toBe("review_run_details");
    expect(viewModel.now.title).toBe("Chat is waiting for your answer");
    expect(viewModel.blockers.map((blocker) => blocker.id)).toEqual(
      expect.arrayContaining(["answer-required", "refresh-failed", "durable-recovery", "delegation-failed"]),
    );
    expect(viewModel.continuationGate.reasonCodes).toContain("user_input_wait");
    expect(viewModel.evidenceSummary.label).toBe("Evidence: pause gate");
    expect(viewModel.roleItems.items.some((item) => item.id === "delegation-delegate-1")).toBe(true);
    expect(viewModel.outputItems.items.map((item) => item.id)).toEqual(["stitched-output", "worktree-state"]);
    expect(viewModel.outputItems.items[0]).toMatchObject({
      title: "Delegation output still in progress",
      note: expect.stringContaining("final synthesis is not ready"),
    });
    expect(viewModel.runMap.planNodes[0]).toEqual(
      expect.objectContaining({ id: "role-role-1", label: "Researcher", status: "failed" }),
    );
  });

  it("uses failure, refresh, task, and checkpoint continuation actions", () => {
    const failed = deriveCoworkRunViewModel({
      items: [],
      orchestrationRun: { runId: "run-1", status: "failed", lastError: "Provider failed" } as never,
      activeTurn: makeTurn({
        status: "failed",
        failure: { message: "Provider failed" },
        toolRuns: [{ status: "failed" }],
      }),
    });
    expect(failed.nextAction?.kind).toBe("retry_turn");
    expect(failed.continuationGate.reasonCodes).toContain("failure_streak");

    const refresh = deriveCoworkRunViewModel({
      items: [],
      orchestrationError: "Gateway unavailable",
      orchestrationLoading: true,
    });
    expect(refresh.nextAction?.kind).toBe("refresh_run_state");
    expect(refresh.freshnessLabel).toBe("Freshness: loading live run state");
    expect(refresh.continuationGate.reasonCodes).toContain("state_gap");

    const tasks = deriveCoworkRunViewModel({
      items: [{ id: "task-1", title: "Follow up" }],
    });
    expect(tasks.nextAction?.kind).toBe("open_tasks");

    const invalidGate = deriveCoworkRunViewModel({
      items: [],
      orchestrationCheckpoints: [
        checkpoint("continuation_gate", { continuationGate: { decision: "invalid", metrics: {} } }),
        checkpoint("phase_executed"),
      ],
    });
    expect(invalidGate.continuationGate.decision).toBe("continue");
    expect(invalidGate.continuationGate.metrics.stepsSinceCheckpoint).toBe(1);
  });

  it("normalizes execution states, summaries, phase labels, and continuation gate fallbacks", () => {
    const executionStates = [
      ["worktree_allocating", "allocating worktree"],
      ["paused_for_approval", "paused for approval"],
      ["resume_requested", "resume queued"],
      ["stopped_by_limit", "stopped by limit"],
    ] as const;

    for (const [executionState, label] of executionStates) {
      const viewModel = deriveCoworkRunViewModel({
        items: [],
        orchestrationRun: {
          runId: `run-${executionState}`,
          status: "running",
          executionState,
          currentPhaseId: "non_numeric_phase",
        } as never,
        orchestrationCheckpoints: [
          {
            ...checkpoint("continuation_gate", {
              continuationGate: {
                decision: "pause",
                metrics: {},
              },
            }),
            phaseId: "review_phase",
            waveId: "wave_alpha",
          },
        ],
      });

      expect(viewModel.now.summary).toContain(label);
      expect(viewModel.timelineItems.items[0]?.meta).toBe("Phase review phase · Wave wave alpha");
      expect(viewModel.continuationGate).toMatchObject({
        reasonCodes: [],
        summary: "Continuation gate: pause.",
        recommendedAction: "Review the run state before continuing.",
      });
    }

    const blankSummary = deriveCoworkRunViewModel({
      items: [],
      agenticRunTree: {
        runId: "agentic-blank",
        generatedAt: "2026-05-04T00:00:00.000Z",
        nodes: [],
        edges: [],
        diagnostics: [{ signalId: "signal-blank", code: "blank", severity: "info", title: "Blank", summary: " \n\t " }],
        controls: [],
      } as never,
    });
    expect(blankSummary.agenticRuntime?.diagnostics[0]?.note).toBeUndefined();

    const longSummary = deriveCoworkRunViewModel({
      items: [],
      agenticRunTree: {
        runId: "agentic-long",
        generatedAt: "2026-05-04T00:00:00.000Z",
        nodes: [],
        edges: [],
        diagnostics: [
          {
            signalId: "signal-long",
            code: "long",
            severity: "warning",
            title: "Long",
            summary: "word ".repeat(80),
          },
        ],
        controls: [],
      } as never,
    });
    expect(longSummary.agenticRuntime?.diagnostics[0]?.note?.endsWith("...")).toBe(true);
  });

  it("covers fallback summaries for delegation-only plans and default durable recovery copy", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: makeTurn({
        durable: { recoveryState: "lease_lost" },
        toolRuns: [],
      }),
      delegationRun: {
        runId: "delegation-only",
        label: "Delegation only",
        objective: "Run a delegation-only workflow.",
        mode: "parallel",
        status: "running",
        steps: [
          {
            stepId: "delegate-1",
            role: "Analyst",
            status: "running",
            childSessionId: "child-1",
          },
        ],
      },
      orchestrationCheckpoints: [checkpoint("run_started", { note: "" })],
      agenticRunTree: {
        runId: "agentic-empty",
        generatedAt: "2026-05-04T00:00:00.000Z",
        nodes: [{ id: "node-1", kind: "worker", label: "Worker", status: null }],
        edges: [],
        diagnostics: [{ signalId: "signal-1", code: "ok", severity: "info", title: "No summary", summary: "" }],
        controls: [{ action: "pause", label: "Pause", enabled: false, requiresApproval: true }],
      } as never,
    });

    expect(viewModel.blockers.find((blocker) => blocker.id === "durable-recovery")?.summary).toBe(
      "Worker state is lease lost for the linked durable run.",
    );
    expect(viewModel.completenessLabel).toBe("Completeness: delegation running");
    expect(viewModel.runMap.planNodes[0]).toEqual(
      expect.objectContaining({ id: "delegation-delegate-1", label: "Analyst", meta: "child-1" }),
    );
    expect(viewModel.timelineItems.items[0]?.note).toBe("2026-05-04T00:00:00.000Z");
    expect(viewModel.agenticRuntime?.diagnostics[0]?.note).toBeUndefined();
    expect(viewModel.agenticRuntime?.controls[0]?.status).toBe("disabled");
    expect(viewModel.agenticRuntime?.controls[0]?.meta).toBe("approval required");
  });
});
