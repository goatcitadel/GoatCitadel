import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNeedsAttentionItems,
  buildSectionDegradedSources,
  capitalize,
  createScheduleJobId,
  describeOpsDegradedSources,
  describeQmdImpact,
  descriptionForOpsSection,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatHumanSessionTitle,
  formatLoadAverage,
  formatShortSessionId,
  formatTokenDelta,
  formatUsd,
  labelForOpsSection,
  RuntimeRoutePage,
  sourceFailed,
} from "./RuntimeRoutePage";

const runtimeApiMocks = vi.hoisted(() => ({
  createCronJob: vi.fn(),
  draftAutomationRecipe: vi.fn(),
  exportActivepiecesWorkflowTemplate: vi.fn(),
  exportN8nWorkflowTemplate: vi.fn(),
}));

const reviewReadinessApiMocks = vi.hoisted(() => ({
  fetchReviewReadiness: vi.fn(() =>
    Promise.resolve({
      branch: "codex/review-readiness",
      sha: "abc123456789",
      generatedAt: "2026-04-22T00:00:00.000Z",
      lanes: [
        {
          lane: "skills-catalog",
          status: "current",
          artifactRef: "artifacts/verification/skills-catalog.json",
          lastRunAt: "2026-04-22T00:00:00.000Z",
          rerunHint: "pnpm verify:skills:catalog",
        },
      ],
      openFindings: 1,
      linkedTasks: [],
    }),
  ),
}));

const runtimeSnapshotOverrides = vi.hoisted(() => ({
  sourceStatus: null as null | Record<string, { status: "ok" | "error"; error?: string }>,
  daemon: undefined as unknown,
  health: undefined as unknown,
  data: undefined as unknown,
  daemonBusy: null as null | "start" | "restart" | "stop",
  notice: undefined as unknown,
  reload: vi.fn(),
  runDaemonAction: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  createCronJob: runtimeApiMocks.createCronJob,
  draftAutomationRecipe: runtimeApiMocks.draftAutomationRecipe,
  exportActivepiecesWorkflowTemplate: runtimeApiMocks.exportActivepiecesWorkflowTemplate,
  exportN8nWorkflowTemplate: runtimeApiMocks.exportN8nWorkflowTemplate,
}));

vi.mock("@goatcitadel/mission-control-shared/api/review-readiness", () => ({
  fetchReviewReadiness: reviewReadinessApiMocks.fetchReviewReadiness,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot", () => ({
  useOpsRuntimeSnapshot: () => ({
    loading: false,
    error: null,
    notice:
      runtimeSnapshotOverrides.notice === undefined
        ? { tone: "success", message: "Daemon restarted." }
        : runtimeSnapshotOverrides.notice,
    daemonBusy: runtimeSnapshotOverrides.daemonBusy,
    reload: runtimeSnapshotOverrides.reload,
    runDaemonAction: runtimeSnapshotOverrides.runDaemonAction,
    data:
      runtimeSnapshotOverrides.data === undefined
        ? {
            dashboard: {
              timestamp: "2026-04-22T00:00:00.000Z",
              sessions: [
                {
                  sessionId: "session-dashboard",
                  displayName: "Dashboard session",
                  channel: "chat",
                  lastActivityAt: "2026-04-22T00:00:00.000Z",
                },
              ],
              pendingApprovals: 2,
              activeSubagents: 3,
              taskStatusCounts: [],
              recentEvents: [{ eventType: "approval.created", source: "gateway" }],
              dailyCostUsd: 12.34,
            },
            timeline: {
              generatedAt: "2026-04-22T00:00:00.000Z",
              events: {
                items: [
                  {
                    eventId: "evt-1",
                    sequence: 1,
                    eventType: "approval.created",
                    source: "gateway",
                    timestamp: "2026-04-22T00:00:00.000Z",
                    payload: {},
                  },
                ],
              },
              sessions: { items: [] },
              scheduler: {
                jobs: [
                  {
                    jobId: "job-1",
                    name: "Daily review",
                    enabled: true,
                    action: "review",
                    nextRunAt: "2026-04-23T00:00:00.000Z",
                  },
                ],
                reviewQueue: [
                  {
                    itemId: "review-1",
                    reason: "Needs operator review",
                    status: "queued",
                    scheduledFor: "2026-04-23T00:00:00.000Z",
                  },
                ],
              },
              improvement: {
                reports: [
                  {
                    reportId: "report-1",
                    runId: "run-1",
                    title: "Quality review",
                    createdAt: "2026-04-22T00:00:00.000Z",
                  },
                ],
                replayRuns: [
                  {
                    runId: "replay-1",
                    status: "completed",
                    createdAt: "2026-04-22T00:05:00.000Z",
                    updatedAt: "2026-04-22T00:10:00.000Z",
                  },
                ],
              },
            },
            health:
              runtimeSnapshotOverrides.health === undefined
                ? {
                    generatedAt: "2026-04-22T00:00:00.000Z",
                    systemVitals: {
                      hostname: "goat",
                      platform: "win32",
                      release: "1.0",
                      uptimeSeconds: 3600,
                      loadAverage: [0.2, 0.1, 0.05],
                      cpuCount: 8,
                      memoryTotalBytes: 1000,
                      memoryFreeBytes: 400,
                      memoryUsedBytes: 600,
                      processRssBytes: 300,
                      processHeapUsedBytes: 200,
                    },
                    daemonStatus: {
                      running: true,
                      pid: 42,
                      uptimeSeconds: 1200,
                      host: "localhost",
                      state: "running",
                      supported: true,
                      controllable: true,
                      controlMessage: "ok",
                    },
                    daemonLogs: { items: [] },
                    costs: {
                      summary: {
                        scope: "day",
                        from: "",
                        to: "",
                        items: [],
                        usageAvailability: { trackedEvents: 12, unknownEvents: 1, totalAgentEvents: 13 },
                      },
                      qmd: {
                        totalRuns: 8,
                        compressionPercent: 24,
                        expansionPercent: 0,
                        efficiencyLabel: "reduced",
                        netTokenDelta: -320,
                      },
                    },
                    backups: { items: [], latest: null },
                  }
                : runtimeSnapshotOverrides.health,
            cost: {
              scope: "day",
              from: "",
              to: "",
              usageAvailability: { trackedEvents: 12, unknownEvents: 1, totalAgentEvents: 13 },
              dailySeries: [
                {
                  isoDate: "2026-04-20",
                  shortLabel: "Mon",
                  segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 1 }],
                },
                {
                  isoDate: "2026-04-21",
                  shortLabel: "Tue",
                  segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 1 }],
                },
                {
                  isoDate: "2026-04-22",
                  shortLabel: "Wed",
                  segments: [{ providerKey: "anthropic", label: "Anthropic", costUsd: 4 }],
                },
              ],
              items: [
                {
                  key: "openai:gpt-5",
                  tokenInput: 0,
                  tokenOutput: 0,
                  tokenCachedInput: 0,
                  tokenTotal: 4000,
                  costUsd: 12.34,
                },
              ],
            },
            daemon:
              runtimeSnapshotOverrides.daemon === undefined
                ? {
                    running: true,
                    pid: 42,
                    uptimeSeconds: 1200,
                    host: "localhost",
                    state: "running",
                    supported: true,
                    controllable: true,
                    controlMessage: "ok",
                  }
                : runtimeSnapshotOverrides.daemon,
            backups: [],
            sessions: [
              {
                sessionId: "session-1",
                displayName: "Chat session",
                channel: "chat",
                lastActivityAt: "2026-04-22T00:00:00.000Z",
              },
            ],
            mcpServers: [{ serverId: "srv-1", label: "GitHub", transport: "stdio", enabled: true, category: "code" }],
            runtimeMeasurements: [
              {
                measurementId: "measure-1",
                providerId: "openai",
                model: "gpt-5",
                engineKind: "remote_api",
                source: "live",
                status: "completed",
                stream: false,
                collectedAt: "2026-04-22T00:00:00.000Z",
                metrics: {
                  latencyMs: 800,
                  outputTokensPerSecond: 22,
                  estimatedCostUsd: 0.0123,
                },
                provenance: { collector: "gateway", path: "chat_completion" },
              },
            ],
            localEngines: [
              {
                engineKind: "ollama",
                label: "Ollama",
                configured: true,
                invocation: "openai_compatible",
                providerIds: ["ollama"],
                measurementSource: "cached",
                fit: "ok",
                notes: ["Measured through an OpenAI-compatible provider."],
              },
            ],
            evalProofRuns: [
              {
                runId: "eval-proof-run-1",
                promptHash: "hash-1",
                status: "completed",
                createdAt: "2026-04-22T00:00:00.000Z",
                candidates: [{ providerId: "openai", model: "gpt-5" }],
                results: [
                  {
                    providerId: "openai",
                    model: "gpt-5",
                    measurementSource: "live",
                    qualityScoreSource: "operator",
                    latencyMs: 800,
                    estimatedCostUsd: 0.0123,
                    paretoOptimal: true,
                    notes: [],
                  },
                ],
                warnings: [],
              },
            ],
            sourceStatus: {
              dashboard: { status: "ok" },
              timeline: { status: "ok" },
              health: { status: "ok" },
              cost: { status: "ok" },
              daemon: { status: "ok" },
              backups: { status: "ok" },
              sessions: { status: "ok" },
              mcpServers: { status: "ok" },
              runtimeMeasurements: { status: "ok" },
              localEngines: { status: "ok" },
              evalProofRuns: { status: "ok" },
              ...(runtimeSnapshotOverrides.sourceStatus ?? {}),
            },
          }
        : runtimeSnapshotOverrides.data,
  }),
}));

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!button) {
    throw new Error(`Missing button ${label}`);
  }
  return button;
}

function findExactButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === "button" && collectText(node).trim() === label)[0];
  if (!button) {
    throw new Error(`Missing exact button ${label}`);
  }
  return button;
}

function findFieldControl(
  root: ReactTestInstance,
  label: string,
  control: "input" | "select" | "textarea",
): ReactTestInstance {
  const field = root.findAll((node) => node.type === "label" && collectText(node).includes(label))[0];
  if (!field) {
    throw new Error(`Missing field ${label}`);
  }
  return field.findByType(control);
}

function findFirstByClass(root: ReactTestInstance, className: string): ReactTestInstance {
  const match = root.findAll((node) => {
    const value = node.props.className;
    return typeof value === "string" && value.split(/\s+/).includes(className);
  })[0];
  if (!match) {
    throw new Error(`Missing class ${className}`);
  }
  return match;
}

describe("RuntimeRoutePage", () => {
  afterEach(() => {
    runtimeSnapshotOverrides.sourceStatus = null;
    runtimeSnapshotOverrides.daemon = undefined;
    runtimeSnapshotOverrides.health = undefined;
    runtimeSnapshotOverrides.data = undefined;
    runtimeSnapshotOverrides.daemonBusy = null;
    runtimeSnapshotOverrides.notice = undefined;
    runtimeApiMocks.createCronJob.mockReset();
    runtimeApiMocks.draftAutomationRecipe.mockReset();
    runtimeApiMocks.exportActivepiecesWorkflowTemplate.mockReset();
    runtimeApiMocks.exportN8nWorkflowTemplate.mockReset();
    reviewReadinessApiMocks.fetchReviewReadiness.mockClear();
    runtimeSnapshotOverrides.reload.mockClear();
    runtimeSnapshotOverrides.runDaemonAction.mockClear();
  });

  it("renders runtime posture and daemon controls in the Ops route", () => {
    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "runtime", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Runtime posture");
    expect(markup).toContain("Daemon running");
    expect(markup).toContain("Start daemon");
    expect(markup).toContain("Restart daemon");
    expect(markup).toContain("LLM runtime efficiency");
    expect(markup).toContain("Local engine fit");
    expect(markup).toContain("Eval evidence");
  });

  it("covers runtime route formatting and schedule helper edges", () => {
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    expect(formatHumanSessionTitle({ sessionId: "sess_abc123", displayName: "  Planning " })).toBe("Planning");
    expect(
      formatHumanSessionTitle({
        sessionId: "sess_abc123456789",
        displayName: "sess_placeholder",
        channel: "cowork",
        lastActivityAt: "2026-05-14T11:30:00.000Z",
      }),
    ).toContain("Cowork session");
    expect(formatHumanSessionTitle({ sessionId: "sess_abc123456789" })).toContain("session abc");
    expect(formatShortSessionId("sess_abcdefghijklmnopqrstuvwxyz")).toBe("session abcdefghijklmn");
    expect(createScheduleJobId("  Daily Review! ")).toMatch(/^manual-daily-review-[a-z0-9]+$/);
    expect(createScheduleJobId(" !!! ")).toMatch(/^manual-schedule-[a-z0-9]+$/);
    expect(capitalize("runtime")).toBe("Runtime");
    expect(capitalize("")).toBe("");
    expect(labelForOpsSection("schedules" as any)).toBe("Schedules");
    expect(labelForOpsSection("sessions" as any)).toBe("Sessions");
    expect(labelForOpsSection("improvement" as any)).toBe("Improvement");
    expect(labelForOpsSection("notifications" as any)).toBe("Notifications");
    expect(labelForOpsSection("costs" as any)).toBe("Costs");
    expect(labelForOpsSection("runtime" as any)).toBe("Runtime");
    expect(labelForOpsSection("unknown" as any)).toBe("Activity");
    expect(descriptionForOpsSection("sessions" as any)).toContain("Recent session");
    expect(descriptionForOpsSection("schedules" as any)).toContain("Scheduled work");
    expect(descriptionForOpsSection("improvement" as any)).toContain("Replay");
    expect(descriptionForOpsSection("notifications" as any)).toContain("Operator-facing");
    expect(descriptionForOpsSection("costs" as any)).toContain("Spend");
    expect(descriptionForOpsSection("runtime" as any)).toContain("Daemon controls");
    expect(descriptionForOpsSection("diagnostics" as any)).toContain("System vitals");
    expect(descriptionForOpsSection("unknown" as any)).toContain("Operational signal");
    expect(describeQmdImpact("reduced")).toBe("Reduced");
    expect(describeQmdImpact("expanded")).toBe("Expanded");
    expect(describeQmdImpact("neutral")).toBe("Stable");
    expect(formatTokenDelta(42.4)).toBe("+42 tokens");
    expect(formatTokenDelta(-42.6)).toBe("-43 tokens");
    expect(formatTokenDelta(Number.NaN)).toBe("no token delta");
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(Number.NaN)).toBe("0m");
    expect(formatDuration(125)).toBe("2m");
    expect(formatDuration(3720)).toBe("1h 2m");
    expect(sourceFailed({ sourceStatus: { daemon: { status: "error" } } }, "daemon")).toBe(true);
    expect(sourceFailed({ sourceStatus: { daemon: { status: "ok" } } }, "daemon")).toBe(false);
    expect(sourceFailed({ sourceStatus: {} }, "daemon")).toBe(false);
    // F-H3: relied-upon source failures are reported per section, not hidden.
    expect(
      buildSectionDegradedSources({ sourceStatus: { cost: { status: "error", message: "gateway down" } } }, "costs"),
    ).toEqual([{ source: "cost", message: "gateway down" }]);
    // A failure of a source the section does not rely on is not surfaced here.
    expect(
      buildSectionDegradedSources({ sourceStatus: { localEngines: { status: "error", message: "x" } } }, "costs"),
    ).toEqual([]);
    expect(buildSectionDegradedSources({ sourceStatus: { cost: { status: "ok" } } }, "costs")).toEqual([]);
    expect(
      buildSectionDegradedSources(
        { sourceStatus: { timeline: { status: "error", message: "timeline failed" } } },
        "improvement",
      ),
    ).toEqual([{ source: "timeline", message: "timeline failed" }]);
    expect(describeOpsDegradedSources([])).toBe("");
    expect(describeOpsDegradedSources([{ source: "cost", message: "x" }])).toContain("Cost source is unavailable");
    expect(
      describeOpsDegradedSources([
        { source: "daemon", message: "x" },
        { source: "health", message: "y" },
      ]),
    ).toContain("Daemon and Health sources are unavailable");
    expect(describeOpsDegradedSources([{ source: "cost", message: "x" }])).toContain("not a healthy zero");
    const attentionItems = buildNeedsAttentionItems(
      {
        dashboard: { pendingApprovals: 1, activeSubagents: 0, dailyCostUsd: 0 },
        timeline: {
          events: {
            items: [
              {
                eventId: "evt-failed",
                eventType: "durable.failed",
                eventClass: "runtime",
                source: "gateway",
                timestamp: "2026-05-14T12:00:00.000Z",
              },
            ],
          },
          scheduler: { jobs: [], reviewQueue: [{ itemId: "review-1" }] },
        },
        health: { daemonStatus: { running: false, state: "stopped" }, backups: { latest: null } },
        cost: null,
        daemon: { running: false, state: "stopped" },
        backups: [],
        sessions: [],
        mcpServers: [],
        sourceStatus: {
          dashboard: { status: "ok" },
          timeline: { status: "ok" },
          health: { status: "ok" },
          cost: { status: "error", message: "cost offline" },
          daemon: { status: "ok" },
          backups: { status: "ok" },
          sessions: { status: "ok" },
          mcpServers: { status: "ok" },
        },
      } as any,
      0,
      "ops" as any,
    );
    expect(attentionItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "pending-approvals",
        "daemon-runtime",
        "backup-posture",
        "scheduler-review",
        "spend-coverage",
        "failed-runtime-event",
        "source-cost",
      ]),
    );
    expect(attentionItems.every((item) => item.primaryLabel && item.inspectLabel)).toBe(true);
    expect(attentionItems.find((item) => item.id === "source-cost")?.body).toBe("cost offline");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    expect(formatBytes(1024 * 1024 * 12)).toBe("12 MB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(1.23456)).toBe("$1.2346");
    expect(formatDateTime(null)).toBe("Unknown");
    expect(formatDateTime("bad-date")).toBe("Unknown");
    expect(formatDateTime("2026-05-14T12:00:00.000Z")).toContain("5/14");
    expect(formatLoadAverage([])).toBe("n/a");
    expect(formatLoadAverage([1, 2.345, 3.456, 4])).toBe("1.00 / 2.35 / 3.46");
  });

  it("creates schedules from the native schedules route and validates required fields", async () => {
    runtimeApiMocks.createCronJob.mockResolvedValue({ jobId: "manual-daily-review-test" });
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "schedules", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Create schedule").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Name and schedule are required.");

    const inputs = renderer!.root.findAllByType("input");
    const actionSelect = renderer!.root.findByType("select");
    await act(async () => {
      inputs[0]!.props.onChange({ target: { value: "Daily review" } });
      inputs[1]!.props.onChange({ target: { value: "0 10 * * *" } });
      actionSelect.props.onChange({ target: { value: "backup" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create schedule").props.onClick();
    });

    expect(runtimeApiMocks.createCronJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Daily review",
        schedule: "0 10 * * *",
        action: "backup",
        enabled: true,
      }),
    );
    expect(runtimeSnapshotOverrides.reload).toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain("Schedule created.");
  });

  it("previews automation recipes without creating cron jobs", async () => {
    runtimeApiMocks.draftAutomationRecipe.mockResolvedValue({
      recipe: {
        name: "Provider spend review automation",
        goal: "Review provider spend and prepare an operator note.",
        steps: [],
        scheduleIntent: { trigger: "manual review", frequency: "weekdays at 9" },
      },
      warnings: ["Operator approval is required before activation."],
      roiEstimate: { confidence: 0.6, rationale: "Small recurring review task." },
      proofChecklist: ["Review generated recipe", "Validate schedule intent", "Confirm no cron job was created"],
      missingCapabilities: [],
    });
    runtimeApiMocks.exportActivepiecesWorkflowTemplate.mockResolvedValue({
      version: "workflow_recipe.activepieces_template_export.v1",
      generatedAt: "2026-05-31T12:00:00.000Z",
      filename: "provider-spend-review-activepieces-template.json",
      contentType: "application/json",
      content: '{"version":"workflow_recipe.activepieces_template_export.v1"}',
      recipe: {
        name: "Provider spend review automation",
        goal: "Review provider spend and prepare an operator note.",
        process: "sequential",
        agents: [],
        steps: [],
      },
      plan: { planId: "recipe-provider-spend-review" },
      warnings: [],
      requiredApprovals: [],
      missingTools: [],
      missingSkills: [],
      estimatedLimits: { maxIterations: 2, maxRuntimeMinutes: 20, maxCostUsd: 1 },
      activepiecesTemplate: {
        name: "Provider spend review automation - GoatCitadel review",
        description: "Review provider spend and prepare an operator note.",
        trigger: { type: "webhook", path: "/goatcitadel/provider-spend-review", method: "POST" },
        steps: [],
        metadata: {
          source: "goatcitadel.workflow_recipe",
          planId: "recipe-provider-spend-review",
          approvalMode: "none",
        },
      },
      validation: {
        status: "ready_for_operator_import_review",
        nativeImportCompatibility: "not_verified",
        checks: [
          {
            id: "webhook-trigger",
            label: "Webhook trigger",
            status: "passed",
            detail: "Template declares a POST webhook path for operator import.",
          },
          {
            id: "native-activepieces-import",
            label: "Native Activepieces import",
            status: "warning",
            detail: "Native Activepieces import-schema compatibility has not been verified by GoatCitadel.",
          },
        ],
        notes: ["Validate inside Activepieces before enabling a flow."],
      },
      posture: {
        readOnly: true,
        sideEffectPosture: "not_executed",
        importRequired: true,
        execution: "operator_import_required",
      },
    });
    runtimeApiMocks.exportN8nWorkflowTemplate.mockResolvedValue({
      version: "workflow_recipe.n8n_template_export.v1",
      generatedAt: "2026-05-31T12:00:00.000Z",
      filename: "provider-spend-review-n8n-template.json",
      contentType: "application/json",
      target: "n8n",
      content: '{"version":"workflow_recipe.n8n_template_export.v1"}',
      recipe: {
        name: "Provider spend review automation",
        goal: "Review provider spend and prepare an operator note.",
        process: "sequential",
        agents: [],
        steps: [],
      },
      plan: { planId: "recipe-provider-spend-review" },
      warnings: [],
      requiredApprovals: [],
      missingTools: [],
      missingSkills: [],
      estimatedLimits: { maxIterations: 2, maxRuntimeMinutes: 20, maxCostUsd: 1 },
      n8nWorkflow: {
        name: "Provider spend review automation - GoatCitadel review",
        active: false,
        nodes: [],
        connections: {},
        settings: {},
        meta: {
          source: "goatcitadel.workflow_recipe",
          planId: "recipe-provider-spend-review",
          approvalMode: "none",
        },
      },
      validation: {
        status: "ready_for_operator_import_review",
        nativeImportCompatibility: "not_verified",
        checks: [
          {
            id: "webhook-trigger",
            label: "Webhook trigger",
            status: "passed",
            detail: "Workflow declares a webhook path for operator import review.",
          },
          {
            id: "native-n8n-import",
            label: "Native n8n import",
            status: "warning",
            detail: "Native n8n import-schema compatibility has not been verified by GoatCitadel.",
          },
        ],
        notes: ["Validate inside n8n before enabling a workflow."],
      },
      posture: {
        readOnly: true,
        sideEffectPosture: "not_executed",
        importRequired: true,
        execution: "operator_import_required",
      },
    });
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "schedules", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Preview recipe").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Task description is required.");

    await act(async () => {
      findFieldControl(renderer!.root, "Task description", "textarea").props.onChange({
        target: { value: "Review provider spend and prepare a note." },
      });
      findFieldControl(renderer!.root, "Trigger", "input").props.onChange({ target: { value: "manual review" } });
      findFieldControl(renderer!.root, "Frequency", "input").props.onChange({ target: { value: "weekdays at 9" } });
      findFieldControl(renderer!.root, "Success criteria", "input").props.onChange({
        target: { value: "fresh spend summary, clear operator note" },
      });
      findFieldControl(renderer!.root, "Constraints", "input").props.onChange({
        target: { value: "no provider setting changes" },
      });
    });
    await act(async () => {
      findButton(renderer!.root, "Preview recipe").props.onClick();
    });

    expect(runtimeApiMocks.draftAutomationRecipe).toHaveBeenCalledWith({
      taskDescription: "Review provider spend and prepare a note.",
      trigger: "manual review",
      frequency: "weekdays at 9",
      successCriteria: ["fresh spend summary", "clear operator note"],
      constraints: ["no provider setting changes"],
      workspaceId: "default",
    });
    expect(runtimeApiMocks.createCronJob).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain("Automation recipe drafted. No cron job was created.");
    expect(collectText(renderer!.root)).toContain("Provider spend review automation");
    expect(collectText(renderer!.root)).toContain("Confirm no cron job was created");
    expect(collectText(renderer!.root)).toContain("Copy n8n template");

    await act(async () => {
      findButton(renderer!.root, "Copy Activepieces template").props.onClick();
    });

    expect(runtimeApiMocks.exportActivepiecesWorkflowTemplate).toHaveBeenCalledWith({
      recipe: expect.objectContaining({ name: "Provider spend review automation" }),
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '{"version":"workflow_recipe.activepieces_template_export.v1"}',
    );
    expect(collectText(renderer!.root)).toContain(
      "Copied Activepieces template export provider-spend-review-activepieces-template.json.",
    );
    expect(collectText(renderer!.root)).toContain("Activepieces");
    expect(collectText(renderer!.root)).toContain("ready_for_operator_import_review");

    await act(async () => {
      findButton(renderer!.root, "Copy n8n template").props.onClick();
    });

    expect(runtimeApiMocks.exportN8nWorkflowTemplate).toHaveBeenCalledWith({
      recipe: expect.objectContaining({ name: "Provider spend review automation" }),
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{"version":"workflow_recipe.n8n_template_export.v1"}');
    expect(collectText(renderer!.root)).toContain(
      "Copied n8n template export provider-spend-review-n8n-template.json.",
    );
    expect(collectText(renderer!.root)).toContain("n8n");
    expect(collectText(renderer!.root)).toContain("ready_for_operator_import_review");
    expect(collectText(renderer!.root)).toContain("native import");
    expect(collectText(renderer!.root)).toContain("not verified");
    expect(collectText(renderer!.root)).toContain("No webhook trigger");
  });

  it("surfaces schedule creation failures without clearing the draft", async () => {
    runtimeApiMocks.createCronJob.mockRejectedValueOnce(new Error("cron backend offline"));
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "schedules", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    const inputs = renderer!.root.findAllByType("input");
    await act(async () => {
      inputs[0]!.props.onChange({ target: { value: "Daily review" } });
      inputs[1]!.props.onChange({ target: { value: "0 10 * * *" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create schedule").props.onClick();
    });

    expect(runtimeApiMocks.createCronJob).toHaveBeenCalledWith(expect.objectContaining({ name: "Daily review" }));
    expect(runtimeSnapshotOverrides.reload).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain("cron backend offline");
    expect(renderer!.root.findAllByType("input")[0]!.props.value).toBe("Daily review");
  });

  it("runs daemon controls and refreshes runtime posture", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "runtime", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Start daemon").props.onClick();
      findButton(renderer!.root, "Restart daemon").props.onClick();
      findButton(renderer!.root, "Stop daemon").props.onClick();
      findButton(renderer!.root, "Refresh").props.onClick();
    });

    expect(runtimeSnapshotOverrides.runDaemonAction).toHaveBeenCalledWith("start");
    expect(runtimeSnapshotOverrides.runDaemonAction).toHaveBeenCalledWith("restart");
    expect(runtimeSnapshotOverrides.runDaemonAction).toHaveBeenCalledWith("stop");
    expect(runtimeSnapshotOverrides.reload).toHaveBeenCalledTimes(1);

    runtimeSnapshotOverrides.daemonBusy = "start";
    await act(async () => {
      renderer!.update(
        <RuntimeRoutePage
          route={{ area: "ops", section: "runtime", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    expect(collectText(renderer!.root)).toContain("Starting...");
    expect(findButton(renderer!.root, "Starting...").props.disabled).toBe(true);
  });

  it("renders all ops subsections and their route-specific summaries", () => {
    const sections = [
      ["sessions", "Session evidence"],
      ["schedules", "Scheduler review"],
      ["improvement", "Improvement reports"],
      ["costs", "Spend summary"],
      ["notifications", "Notification signals"],
      ["activity", "Activity feed"],
    ] as const;

    for (const [section, expected] of sections) {
      const markup = renderToStaticMarkup(
        <RuntimeRoutePage
          route={{ area: "ops", section, theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
      expect(markup).toContain(expected);
    }

    runtimeSnapshotOverrides.data = null;
    const noDataMarkup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "activity", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );
    expect(noDataMarkup).toContain("Activity");
    expect(noDataMarkup).not.toContain("Activity feed");
  });

  it("folds notifications into the shared needs-attention inbox", () => {
    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "notifications", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Pending approvals");
    expect(markup).toContain("2");
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("Notification signals");
    expect(markup).not.toContain("approval.created");
  });

  it("filters the activity feed by error, approval, and runtime signals", async () => {
    runtimeSnapshotOverrides.data = {
      dashboard: {
        timestamp: "2026-04-22T00:00:00.000Z",
        sessions: [],
        pendingApprovals: 0,
        activeSubagents: 0,
        taskStatusCounts: [],
        recentEvents: [],
        dailyCostUsd: 0,
      },
      timeline: {
        generatedAt: "2026-04-22T00:00:00.000Z",
        events: {
          items: [
            {
              eventId: "evt-error",
              sequence: 1,
              eventType: "tool.failed",
              eventClass: "error",
              source: "worker",
              timestamp: "2026-04-22T00:00:00.000Z",
              payload: {},
            },
            {
              eventId: "evt-approval",
              sequence: 2,
              eventType: "approval.created",
              eventClass: "decision",
              source: "policy",
              timestamp: "2026-04-22T00:01:00.000Z",
              payload: {},
            },
            {
              eventId: "evt-gateway-approval",
              sequence: 4,
              eventType: "approval.resolved",
              eventClass: "decision",
              source: "gateway",
              timestamp: "2026-04-22T00:01:30.000Z",
              payload: {},
            },
            {
              eventId: "evt-runtime",
              sequence: 3,
              eventType: "daemon.started",
              eventClass: "info",
              source: "runtime",
              timestamp: "2026-04-22T00:02:00.000Z",
              payload: {},
            },
            {
              eventId: "evt-runtime-source",
              sequence: 5,
              eventType: "heartbeat",
              eventClass: "info",
              source: "runtime",
              timestamp: "2026-04-22T00:03:00.000Z",
              payload: {},
            },
          ],
        },
        sessions: { items: [] },
        scheduler: { jobs: [], reviewQueue: [] },
        improvement: { reports: [], replayRuns: [] },
      },
      health: null,
      cost: null,
      daemon: null,
      backups: [],
      sessions: [],
      mcpServers: [],
      sourceStatus: {
        dashboard: { status: "ok" },
        timeline: { status: "ok" },
        health: { status: "ok" },
        cost: { status: "ok" },
        daemon: { status: "ok" },
        backups: { status: "ok" },
        sessions: { status: "ok" },
        mcpServers: { status: "ok" },
      },
    } as any;

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "activity", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={vi.fn()}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    expect(collectText(renderer!.root)).toContain("Tool failed");
    expect(collectText(renderer!.root)).toContain("Approval created");
    expect(collectText(renderer!.root)).toContain("Daemon started");
    expect(findExactButton(renderer!.root, "All").props).toMatchObject({
      role: "radio",
      "aria-checked": true,
    });

    await act(async () => findExactButton(renderer!.root, "Errors").props.onClick());
    expect(collectText(renderer!.root)).toContain("Tool failed");
    expect(collectText(renderer!.root)).not.toContain("Approval created");
    expect(findExactButton(renderer!.root, "Errors").props).toMatchObject({
      role: "radio",
      "aria-checked": true,
    });

    await act(async () => findExactButton(renderer!.root, "Approvals").props.onClick());
    expect(collectText(renderer!.root)).toContain("Approval created");
    expect(collectText(renderer!.root)).not.toContain("Daemon started");

    await act(async () => findExactButton(renderer!.root, "Runtime").props.onClick());
    const runtimeFeedText = collectText(findFirstByClass(renderer!.root, "mc-next-activity-feed"));
    expect(runtimeFeedText).toContain("Daemon started");
    expect(runtimeFeedText).toContain("Heartbeat");
    expect(runtimeFeedText).not.toContain("Approval resolved");
    expect(runtimeFeedText).not.toContain("Tool failed");
  });

  it("renders activity events with duplicate timestamp fallbacks without duplicate key warnings", async () => {
    runtimeSnapshotOverrides.data = {
      dashboard: {
        timestamp: "2026-04-22T00:00:00.000Z",
        sessions: [],
        pendingApprovals: 0,
        activeSubagents: 0,
        taskStatusCounts: [],
        recentEvents: [],
        dailyCostUsd: 0,
      },
      timeline: {
        generatedAt: "2026-04-22T00:00:00.000Z",
        events: {
          items: [
            {
              sequence: 1,
              eventType: "tool.started",
              eventClass: "info",
              source: "worker-a",
              timestamp: "2026-04-22T00:00:00.000Z",
              payload: {},
            },
            {
              sequence: 2,
              eventType: "tool.started",
              eventClass: "info",
              source: "worker-b",
              timestamp: "2026-04-22T00:00:00.000Z",
              payload: {},
            },
          ],
        },
        sessions: { items: [] },
        scheduler: { jobs: [], reviewQueue: [] },
        improvement: { reports: [], replayRuns: [] },
      },
      health: null,
      cost: null,
      daemon: null,
      backups: [],
      sessions: [],
      mcpServers: [],
      sourceStatus: {
        dashboard: { status: "ok" },
        timeline: { status: "ok" },
        health: { status: "ok" },
        cost: { status: "ok" },
        daemon: { status: "ok" },
        backups: { status: "ok" },
        sessions: { status: "ok" },
        mcpServers: { status: "ok" },
      },
    } as any;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = create(
          <RuntimeRoutePage
            route={{ area: "ops", section: "activity", theme: "ops" } as any}
            activeWorkspaceId="default"
            activeWorkspaceName="Default"
            pendingApprovals={0}
            navigate={vi.fn()}
            setActiveWorkspaceId={vi.fn()}
          />,
        );
      });

      expect(collectText(renderer!.root)).toContain("worker-a");
      expect(collectText(renderer!.root)).toContain("worker-b");
      expect(
        consoleErrorSpy.mock.calls.filter((call) =>
          call.some((argument) => String(argument).includes("Encountered two children with the same key")),
        ),
      ).toHaveLength(0);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("navigates with route objects instead of legacy URL strings", async () => {
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <RuntimeRoutePage
          route={{ area: "ops", section: "diagnostics", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={2}
          navigate={navigate}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    const buttons = renderer!.root.findAllByType("button");
    const promptPacksButton = buttons.find(
      (button: ReactTestInstance) =>
        button.findAll((node) => typeof node.props?.children === "string" && node.props.children === "Prompt packs")
          .length > 0,
    );

    expect(promptPacksButton).toBeDefined();
    expect(collectText(renderer!.root)).toContain("Release proof dashboard");
    expect(collectText(renderer!.root)).toContain("Route coverage");
    expect(collectText(renderer!.root)).toContain("Screenshot freshness");
    expect(collectText(renderer!.root)).toContain("Code/Ops review readiness");
    expect(collectText(renderer!.root)).toContain("skills-catalog");

    act(() => {
      promptPacksButton!.props.onClick();
    });

    expect(navigate).toHaveBeenCalledWith({
      area: "library",
      section: "prompt-packs",
      theme: "ops",
    });
    expect(navigate.mock.calls[0]?.[0]).not.toHaveProperty("space");
  });

  it("renders unavailable state instead of false runtime measurements when sources fail", () => {
    runtimeSnapshotOverrides.daemon = null;
    runtimeSnapshotOverrides.health = null;
    runtimeSnapshotOverrides.sourceStatus = {
      daemon: { status: "error", error: "daemon route failed" },
      health: { status: "error", error: "health route failed" },
    };

    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "runtime", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Daemon unavailable");
    expect(markup).toContain("Backup status unavailable");
    expect(markup).toContain("unavailable");
    expect(markup).toContain("<strong>unavailable</strong>");
    expect(markup).not.toContain("<strong>0 B</strong>");
  });

  it("surfaces a degraded strip on the Costs section when the cost source fails (F-H3)", () => {
    runtimeSnapshotOverrides.sourceStatus = {
      cost: { status: "error", error: "cost route failed" },
      dashboard: { status: "error", error: "dashboard route failed" },
    };

    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "costs", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    // The degraded strip renders with role=alert and explains the figures are
    // not a healthy zero, instead of a calm "$0.00 healthy" view.
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Live runtime data is degraded");
    expect(markup).toContain("not a healthy zero");
    expect(markup).toContain("unavailable");
  });

  it("renders no degraded strip on Costs when relied-upon sources are healthy (F-H3)", () => {
    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "costs", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).not.toContain("Live runtime data is degraded");
  });

  it("uses health daemon status when daemon controls are unavailable", () => {
    runtimeSnapshotOverrides.daemon = null;
    runtimeSnapshotOverrides.sourceStatus = {
      daemon: { status: "error", error: "daemon route failed" },
      health: { status: "ok" },
    };

    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "runtime", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={2}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Daemon running");
    expect(markup).toContain("Control status unavailable");
    expect(markup).toContain("<strong>localhost</strong>");
    expect(markup).toContain("<strong>42</strong>");
    expect(markup).not.toContain("Daemon unavailable");
  });

  it("covers degraded runtime formatting, backups, diagnostics, notifications, and QMD variants", () => {
    runtimeSnapshotOverrides.data = {
      dashboard: {
        timestamp: "2026-04-22T00:00:00.000Z",
        sessions: [],
        pendingApprovals: 0,
        activeSubagents: 0,
        taskStatusCounts: [],
        recentEvents: [],
        dailyCostUsd: Number.NaN,
      },
      timeline: {
        generatedAt: "2026-04-22T00:00:00.000Z",
        events: {
          items: [
            {
              eventId: "evt-runtime",
              sequence: 1,
              eventType: "runtime.failed",
              eventClass: "error",
              source: "gateway",
              timestamp: "bad-date",
              payload: {},
            },
          ],
        },
        sessions: { items: [] },
        scheduler: { jobs: [], reviewQueue: [] },
        improvement: { reports: [], replayRuns: [] },
      },
      health: {
        generatedAt: "2026-04-22T00:00:00.000Z",
        systemVitals: {
          hostname: "edge",
          platform: "win32",
          release: "1.0",
          uptimeSeconds: -1,
          loadAverage: [],
          cpuCount: 8,
          memoryTotalBytes: 64 * 1024 * 1024,
          memoryFreeBytes: 0,
          memoryUsedBytes: 10 * 1024 * 1024,
          processRssBytes: 1536,
          processHeapUsedBytes: Number.POSITIVE_INFINITY,
        },
        daemonStatus: {
          running: false,
          pid: 0,
          uptimeSeconds: 0,
          host: "localhost",
          state: "stopped",
          supported: true,
          controllable: false,
          controlMessage: "manual",
        },
        daemonLogs: { items: [{ level: "warn", timestamp: "bad-date", message: "Runtime warning" }] },
        costs: {
          summary: {
            scope: "day",
            from: "",
            to: "",
            items: [],
            usageAvailability: { trackedEvents: 0, unknownEvents: 0, totalAgentEvents: 0 },
          },
          qmd: {
            totalRuns: 1,
            compressionPercent: 0,
            expansionPercent: 14,
            efficiencyLabel: "expanded",
            netTokenDelta: 42.4,
          },
        },
        backups: { items: [], latest: null },
      },
      cost: {
        scope: "month",
        from: "",
        to: "",
        usageAvailability: { trackedEvents: 0, unknownEvents: 0, totalAgentEvents: 0 },
        dailySeries: [
          {
            isoDate: "2026-04-20",
            shortLabel: "Mon",
            segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 1 }],
          },
          {
            isoDate: "2026-04-21",
            shortLabel: "Tue",
            segments: [{ providerKey: "openai", label: "OpenAI", costUsd: 1 }],
          },
          {
            isoDate: "2026-04-22",
            shortLabel: "Wed",
            segments: [{ providerKey: "anthropic", label: "Anthropic", costUsd: 4 }],
          },
        ],
        items: [
          {
            key: "unknown:model",
            tokenInput: 0,
            tokenOutput: 0,
            tokenCachedInput: 0,
            tokenTotal: 0,
            costUsd: Number.NaN,
          },
        ],
      },
      daemon: {
        running: false,
        pid: 0,
        uptimeSeconds: 0,
        host: "edge",
        state: "stopped",
        supported: true,
        controllable: false,
        controlMessage: "manual",
        controlHandoff: {
          owner: "External service manager",
          serviceName: "GoatCitadel Gateway",
          reason: "Use the process manager that owns the gateway.",
          desktopControl: "Mission Control desktop tray > Restart gateway",
          commands: [
            {
              label: "Inspect current process",
              command: "Get-Process -Id 42 -ErrorAction SilentlyContinue",
              description: "Confirms the gateway process.",
            },
            {
              label: "Start local dev gateway",
              command: "pnpm dev:gateway",
              description: "Start the source checkout gateway.",
            },
          ],
        },
      },
      backups: [{ backupId: "backup-1", createdAt: undefined, files: ["a", "b"] }],
      sessions: [],
      mcpServers: [{ serverId: "srv-2", label: "Local MCP", transport: "http", enabled: false }],
      sourceStatus: {
        dashboard: { status: "ok" },
        timeline: { status: "ok" },
        health: { status: "ok" },
        cost: { status: "ok" },
        daemon: { status: "ok" },
        backups: { status: "ok" },
        sessions: { status: "ok" },
        mcpServers: { status: "ok" },
      },
    } as any;

    const commonProps = {
      activeWorkspaceId: "default",
      activeWorkspaceName: "Default",
      pendingApprovals: 0,
      navigate: vi.fn(),
      setActiveWorkspaceId: vi.fn(),
    };

    const runtimeMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "runtime", theme: "ops" } as any} {...commonProps} />,
    );
    expect(runtimeMarkup).toContain("Daemon stopped");
    expect(runtimeMarkup).toContain("No backup");
    expect(runtimeMarkup).toContain("Read only");
    expect(runtimeMarkup).toContain("Manual handoff");
    expect(runtimeMarkup).toContain("External service manager");
    expect(runtimeMarkup).toContain("Mission Control desktop tray &gt; Restart gateway");
    expect(runtimeMarkup).toContain("pnpm dev:gateway");
    expect(runtimeMarkup).toContain("Unknown · 2 files");
    expect(runtimeMarkup).toContain("http · general");
    let readOnlyRenderer: ReactTestRenderer | undefined;
    act(() => {
      readOnlyRenderer = create(
        <RuntimeRoutePage route={{ area: "ops", section: "runtime", theme: "ops" } as any} {...commonProps} />,
      );
    });
    expect(findButton(readOnlyRenderer!.root, "Start daemon").props.disabled).toBe(true);
    expect(findButton(readOnlyRenderer!.root, "Restart daemon").props.disabled).toBe(true);
    expect(findButton(readOnlyRenderer!.root, "Stop daemon").props.disabled).toBe(true);
    act(() => {
      readOnlyRenderer!.unmount();
    });

    const diagnosticsMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "diagnostics", theme: "ops" } as any} {...commonProps} />,
    );
    expect(diagnosticsMarkup).toContain("n/a");
    expect(diagnosticsMarkup).toContain("0m");
    expect(diagnosticsMarkup).toContain("Runtime warning");

    const costsMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "costs", theme: "ops" } as any} {...commonProps} />,
    );
    expect(costsMarkup).toContain("Expanded");
    expect(costsMarkup).toContain("+42 tokens");
    expect(costsMarkup).toContain("Wed spike");
    expect(costsMarkup).toContain("$0.00");

    runtimeSnapshotOverrides.data = {
      ...(runtimeSnapshotOverrides.data as any),
      health: {
        ...(runtimeSnapshotOverrides.data as any).health,
        costs: {
          ...(runtimeSnapshotOverrides.data as any).health.costs,
          qmd: {
            ...(runtimeSnapshotOverrides.data as any).health.costs.qmd,
            efficiencyLabel: "neutral",
            netTokenDelta: 0,
          },
        },
      },
    };
    expect(
      renderToStaticMarkup(
        <RuntimeRoutePage route={{ area: "ops", section: "costs", theme: "ops" } as any} {...commonProps} />,
      ),
    ).toContain("no token delta");

    const notificationsMarkup = renderToStaticMarkup(
      <RuntimeRoutePage route={{ area: "ops", section: "notifications", theme: "ops" } as any} {...commonProps} />,
    );
    expect(notificationsMarkup).toContain("Daemon needs intervention");
    expect(notificationsMarkup).toContain("runtime.failed");
    expect(notificationsMarkup).toContain("Unknown");
  });

  it("renders runtime without notices and with a ready backup signal", () => {
    runtimeSnapshotOverrides.notice = null;
    runtimeSnapshotOverrides.health = {
      generatedAt: "2026-04-22T00:00:00.000Z",
      systemVitals: {
        hostname: "goat",
        platform: "win32",
        release: "1.0",
        uptimeSeconds: 3600,
        loadAverage: [0.2],
        cpuCount: 8,
        memoryTotalBytes: 1000,
        memoryFreeBytes: 400,
        memoryUsedBytes: 600,
        processRssBytes: 300,
        processHeapUsedBytes: 200,
      },
      daemonStatus: {
        running: true,
        pid: 42,
        uptimeSeconds: 1200,
        host: "localhost",
        state: "running",
        supported: true,
        controllable: true,
        controlMessage: "ok",
      },
      daemonLogs: { items: [] },
      costs: {
        summary: {
          scope: "day",
          from: "",
          to: "",
          items: [],
          usageAvailability: { trackedEvents: 0, unknownEvents: 0, totalAgentEvents: 0 },
        },
        qmd: {
          totalRuns: 1,
          compressionPercent: 0,
          expansionPercent: 0,
          efficiencyLabel: "neutral",
          netTokenDelta: 0,
        },
      },
      backups: { items: [], latest: { backupId: "latest-backup" } },
    };

    const markup = renderToStaticMarkup(
      <RuntimeRoutePage
        route={{ area: "ops", section: "runtime", theme: "ops" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Backup present");
    expect(markup).not.toContain("Backup ready");
    expect(markup).not.toContain("Daemon restarted.");
  });
});
