import { createHash } from "node:crypto";
import type {
  OrchestrationPlan,
  OrchestrationRun,
  OrchestrationRunPolicyContext,
  SkillListItem,
  AutomationRecipeDraftRequest,
  AutomationRecipeDraftResponse,
  WorkflowRecipeActivepiecesTemplate,
  WorkflowRecipeActivepiecesTemplateExportRequest,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeActivepiecesTemplateValidation,
  WorkflowRecipeActivepiecesTemplateValidationCheck,
  WorkflowRecipeAgent,
  WorkflowRecipeApproval,
  WorkflowRecipeLimits,
  WorkflowRecipeN8nTemplateExportRequest,
  WorkflowRecipeN8nTemplateExportResponse,
  WorkflowRecipePlanCreateRequest,
  WorkflowRecipePlanCreateResponse,
  WorkflowRecipePreviewRequest,
  WorkflowRecipePreviewResponse,
  WorkflowRecipeProcess,
  WorkflowRecipeRecord,
  WorkflowRecipeStep,
  WorkflowRecipeTemplateRecord,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import { buildN8nWorkflowTemplate, validateN8nTemplateExport } from "./workflow-recipe-n8n-template";

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "name",
  "goal",
  "process",
  "agents",
  "steps",
  "approval",
  "limits",
  "tools",
  "skills",
  "memory",
  "knowledge",
  "scheduleIntent",
  "channelIntent",
]);

const DEFAULT_LIMITS: Required<WorkflowRecipeLimits> = {
  maxIterations: 3,
  maxRuntimeMinutes: 30,
  maxCostUsd: 3,
};

export interface WorkflowRecipeServiceHost {
  listSkills(): SkillListItem[];
  listToolNames?(): string[];
  createOrchestrationPlan(
    plan: OrchestrationPlan,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<OrchestrationRun>;
}

export class WorkflowRecipeService {
  public constructor(private readonly host: WorkflowRecipeServiceHost) {}

  public previewRecipe(input: WorkflowRecipePreviewRequest): WorkflowRecipePreviewResponse {
    const recipe = normalizeRecipe(parseRecipeInput(input));
    const warnings = buildWarnings(recipe);
    const missingSkills = detectMissingSkills(recipe, this.host.listSkills());
    const missingTools = detectMissingTools(recipe, this.host.listToolNames?.() ?? []);
    const estimatedLimits = normalizeLimits(recipe.limits);
    const requiredApprovals = normalizeRequiredApprovals(recipe);
    return {
      recipe,
      plan: buildOrchestrationPlan(recipe, estimatedLimits, requiredApprovals),
      warnings,
      requiredApprovals,
      missingTools,
      missingSkills,
      estimatedLimits,
    };
  }

  public async createPlanFromRecipe(
    input: WorkflowRecipePlanCreateRequest,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<WorkflowRecipePlanCreateResponse> {
    const preview = this.previewRecipe(input);
    const run = policyContext
      ? await this.host.createOrchestrationPlan(preview.plan, policyContext)
      : await this.host.createOrchestrationPlan(preview.plan);
    return {
      ...preview,
      run,
    };
  }

  public listTemplates(): WorkflowRecipeTemplateRecord[] {
    return STARTER_TEMPLATES;
  }

  public draftAutomationRecipe(input: AutomationRecipeDraftRequest): AutomationRecipeDraftResponse {
    const recipe = buildAutomationDraftRecipe(input);
    const preview = this.previewRecipe({ recipe });
    return {
      ...preview,
      roiEstimate: estimateAutomationRoi(input),
      proofChecklist: buildAutomationProofChecklist(input),
      missingCapabilities: [...preview.missingSkills, ...preview.missingTools],
    };
  }

  public exportActivepiecesTemplate(
    input: WorkflowRecipeActivepiecesTemplateExportRequest,
    generatedAt = new Date().toISOString(),
  ): WorkflowRecipeActivepiecesTemplateExportResponse {
    const preview = this.previewRecipe(input);
    const activepiecesTemplate = buildActivepiecesTemplate(preview, input);
    const validation = validateActivepiecesTemplateExport(activepiecesTemplate);
    const filename = `${slugify(activepiecesTemplate.name)}-activepieces-template.json`;
    const posture = {
      readOnly: true,
      sideEffectPosture: "not_executed",
      importRequired: true,
      execution: "operator_import_required",
    } as const;
    const payload = {
      version: "workflow_recipe.activepieces_template_export.v1" as const,
      generatedAt,
      filename,
      contentType: "application/json" as const,
      posture,
      recipe: preview.recipe,
      plan: preview.plan,
      warnings: [
        ...preview.warnings,
        "Activepieces template export is a read-only planning artifact; it does not create a flow or trigger a webhook.",
      ],
      requiredApprovals: preview.requiredApprovals,
      missingTools: preview.missingTools,
      missingSkills: preview.missingSkills,
      estimatedLimits: preview.estimatedLimits,
      activepiecesTemplate,
      validation,
    };
    return {
      ...preview,
      warnings: payload.warnings,
      version: payload.version,
      generatedAt,
      filename,
      contentType: payload.contentType,
      activepiecesTemplate,
      validation,
      posture,
      content: JSON.stringify(payload, null, 2),
    };
  }

  public exportN8nTemplate(
    input: WorkflowRecipeN8nTemplateExportRequest,
    generatedAt = new Date().toISOString(),
  ): WorkflowRecipeN8nTemplateExportResponse {
    const preview = this.previewRecipe(input);
    const n8nWorkflow = buildN8nWorkflowTemplate(preview, input);
    const validation = validateN8nTemplateExport(n8nWorkflow);
    const filename = `${slugify(n8nWorkflow.name)}-n8n-template.json`;
    const posture = {
      readOnly: true,
      sideEffectPosture: "not_executed",
      importRequired: true,
      execution: "operator_import_required",
    } as const;
    const payload = {
      version: "workflow_recipe.n8n_template_export.v1" as const,
      generatedAt,
      filename,
      contentType: "application/json" as const,
      target: "n8n" as const,
      posture,
      recipe: preview.recipe,
      plan: preview.plan,
      warnings: [
        ...preview.warnings,
        "n8n template export is a read-only planning artifact; it does not create a workflow, trigger a webhook, poll, or run tools.",
      ],
      requiredApprovals: preview.requiredApprovals,
      missingTools: preview.missingTools,
      missingSkills: preview.missingSkills,
      estimatedLimits: preview.estimatedLimits,
      n8nWorkflow,
      validation,
    };
    return {
      ...preview,
      warnings: payload.warnings,
      version: payload.version,
      generatedAt,
      filename,
      contentType: payload.contentType,
      target: payload.target,
      n8nWorkflow,
      validation,
      posture,
      content: JSON.stringify(payload, null, 2),
    };
  }
}

function validateActivepiecesTemplateExport(
  template: WorkflowRecipeActivepiecesTemplate,
): WorkflowRecipeActivepiecesTemplateValidation {
  const checks: WorkflowRecipeActivepiecesTemplateValidationCheck[] = [
    template.trigger.type === "webhook" &&
    template.trigger.method === "POST" &&
    template.trigger.path.startsWith("/") &&
    template.trigger.path.length > 1
      ? {
          id: "webhook-trigger",
          label: "Webhook trigger",
          status: "passed",
          detail: "Template declares a POST webhook path for operator import.",
        }
      : {
          id: "webhook-trigger",
          label: "Webhook trigger",
          status: "blocked",
          detail: "Template export requires a non-root POST webhook path.",
        },
    template.steps.length > 0
      ? {
          id: "step-plan",
          label: "Step plan",
          status: "passed",
          detail: `${template.steps.length} GoatCitadel review step${template.steps.length === 1 ? "" : "s"} included as planning metadata.`,
        }
      : {
          id: "step-plan",
          label: "Step plan",
          status: "warning",
          detail: "No workflow steps were included; operator import would create trigger-only planning evidence.",
        },
    buildActivepiecesStepGraphCheck(template),
    {
      id: "execution-posture",
      label: "Execution posture",
      status: "passed",
      detail: "Export contains prompts and metadata only; it does not create a flow, call a webhook, or run tools.",
    },
    {
      id: "native-activepieces-import",
      label: "Native Activepieces import",
      status: "warning",
      detail: "Native Activepieces import-schema compatibility has not been verified by GoatCitadel.",
    },
  ];
  return {
    status: checks.some((check) => check.status === "blocked") ? "blocked" : "ready_for_operator_import_review",
    nativeImportCompatibility: "not_verified",
    checks,
    notes: [
      "Use this JSON as operator-import planning evidence, then validate it inside Activepieces before enabling a flow.",
      "GoatCitadel does not poll Activepieces or manage Activepieces flow lifecycle from this export.",
    ],
  };
}

function buildActivepiecesStepGraphCheck(
  template: WorkflowRecipeActivepiecesTemplate,
): WorkflowRecipeActivepiecesTemplateValidationCheck {
  const stepIds = new Set<string>();
  const duplicateStepIds = new Set<string>();
  for (const step of template.steps) {
    if (stepIds.has(step.id)) {
      duplicateStepIds.add(step.id);
    }
    stepIds.add(step.id);
  }
  const danglingDependencies = new Set<string>();
  for (const step of template.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        danglingDependencies.add(`${step.id}->${dependency}`);
      }
    }
  }
  if (duplicateStepIds.size === 0 && danglingDependencies.size === 0) {
    return {
      id: "step-graph",
      label: "Step graph",
      status: "passed",
      detail: "All step IDs are unique and dependency references resolve inside the exported planning template.",
    };
  }
  return {
    id: "step-graph",
    label: "Step graph",
    status: "blocked",
    detail: [
      duplicateStepIds.size ? `Duplicate step IDs: ${[...duplicateStepIds].join(", ")}.` : undefined,
      danglingDependencies.size ? `Dangling dependencies: ${[...danglingDependencies].join(", ")}.` : undefined,
      "Review the recipe before operator import.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function buildAutomationDraftRecipe(input: AutomationRecipeDraftRequest): WorkflowRecipeRecord {
  const taskDescription = requireText(input.taskDescription, "taskDescription");
  const trigger = optionalText(input.trigger);
  const frequency = optionalText(input.frequency);
  const constraints = normalizeStringList(input.constraints) ?? [];
  const successCriteria = normalizeStringList(input.successCriteria) ?? [];
  const scheduleIntent = [frequency, trigger].filter(Boolean).join(" · ") || undefined;
  return {
    name: `Automation: ${taskDescription.slice(0, 64)}`,
    goal: taskDescription,
    process: "sequential",
    agents: [
      {
        id: "automation-designer",
        role: "Automation Designer",
        goal: "Draft a reviewable automation plan without creating a cron job or external side effect.",
        skills: ["automation-workflows"],
      },
      {
        id: "qa",
        role: "QA",
        goal: "Identify proof lanes, failure modes, and operator approval points.",
      },
    ],
    steps: [
      {
        id: "scope-and-triggers",
        title: "Scope trigger and safeguards",
        agent: "automation-designer",
        prompt: [
          `Task: ${taskDescription}`,
          trigger ? `Trigger: ${trigger}` : "Trigger: operator review required",
          frequency ? `Frequency: ${frequency}` : "Frequency: not scheduled yet",
          constraints.length ? `Constraints: ${constraints.join("; ")}` : "Constraints: preserve policy gates.",
        ].join("\n"),
        requiresApproval: true,
      },
      {
        id: "proof-plan",
        title: "Draft proof checklist",
        agent: "qa",
        prompt: [
          "Produce a concise proof checklist before any cron or workflow activation.",
          successCriteria.length
            ? `Success criteria: ${successCriteria.join("; ")}`
            : "Success criteria: operator confirms useful result.",
        ].join("\n"),
        dependsOn: ["scope-and-triggers"],
        requiresApproval: true,
      },
    ],
    approval: {
      mode: "before_each_step",
    },
    limits: {
      maxIterations: 2,
      maxRuntimeMinutes: 20,
      maxCostUsd: 1,
    },
    skills: ["automation-workflows"],
    memory: input.workspaceId ? [`workspace:${input.workspaceId}`] : undefined,
    scheduleIntent,
  };
}

function estimateAutomationRoi(input: AutomationRecipeDraftRequest): AutomationRecipeDraftResponse["roiEstimate"] {
  const hasFrequency = Boolean(input.frequency?.trim());
  const hasSuccessCriteria = (input.successCriteria ?? []).some((item) => item.trim());
  return {
    timeSavedMinutesPerRun: hasFrequency ? 15 : undefined,
    confidence: hasFrequency && hasSuccessCriteria ? 0.72 : 0.48,
    notes: [
      "Estimate is advisory and does not create an automation.",
      hasFrequency ? "Frequency supplied, so recurring value can be reviewed." : "No frequency supplied yet.",
      hasSuccessCriteria ? "Success criteria supplied." : "Add success criteria before activation.",
    ],
  };
}

function buildAutomationProofChecklist(input: AutomationRecipeDraftRequest): string[] {
  return [
    "Preview the recipe and missing capabilities.",
    "Confirm approval gates and risk boundaries.",
    input.frequency?.trim()
      ? "Review schedule intent before creating a cron job."
      : "Choose a schedule before cron creation.",
    "Run once manually and inspect artifacts.",
    "Only then create or enable a recurring automation.",
  ];
}

function buildActivepiecesTemplate(
  preview: WorkflowRecipePreviewResponse,
  input: WorkflowRecipeActivepiecesTemplateExportRequest,
): WorkflowRecipeActivepiecesTemplate {
  const recipe = preview.recipe;
  const flowName = optionalText(input.flowName) ?? `${recipe.name} - GoatCitadel review`;
  const webhookPath = optionalText(input.webhookPath) ?? `/goatcitadel/${slugify(recipe.name)}`;
  return {
    name: flowName,
    description: recipe.goal,
    trigger: {
      type: "webhook",
      path: webhookPath,
      method: "POST",
    },
    steps: recipe.steps.map((step) => ({
      id: step.id,
      displayName: step.title,
      agent: step.agent,
      prompt: step.prompt,
      requiresApproval: preview.requiredApprovals.includes(step.id) || step.requiresApproval === true,
      dependsOn: step.dependsOn ?? [],
    })),
    metadata: {
      source: "goatcitadel.workflow_recipe",
      planId: preview.plan.planId,
      approvalMode: preview.requiredApprovals.length > 0 ? "human_in_the_loop" : "none",
      ...(recipe.scheduleIntent ? { scheduleIntent: recipe.scheduleIntent } : {}),
      ...(recipe.channelIntent ? { channelIntent: recipe.channelIntent } : {}),
    },
  };
}

function parseRecipeInput(input: WorkflowRecipePreviewRequest): unknown {
  if (input.recipe !== undefined) {
    return input.recipe;
  }
  const source = input.source?.trim();
  if (!source) {
    throw new ValidationError({ field: "source", message: "Provide a JSON/YAML recipe source or recipe object." });
  }
  if (source.startsWith("{") || source.startsWith("[")) {
    try {
      return JSON.parse(source);
    } catch (error) {
      throw new ValidationError({ field: "source", message: `Invalid JSON recipe: ${(error as Error).message}` });
    }
  }
  return parseSimpleYaml(source);
}

function normalizeRecipe(raw: unknown): WorkflowRecipeRecord {
  if (!isRecord(raw)) {
    throw new ValidationError({ field: "recipe", message: "Recipe must be an object." });
  }
  const unknownKeys = Object.keys(raw).filter((key) => !ALLOWED_TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new ValidationError({
      field: "recipe",
      message: `Unknown recipe top-level key(s): ${unknownKeys.join(", ")}.`,
    });
  }
  const process = normalizeProcess(raw.process);
  const agents = normalizeAgents(raw.agents);
  const steps = normalizeSteps(raw.steps, agents);
  const recipe: WorkflowRecipeRecord = {
    name: requireText(raw.name, "name"),
    goal: requireText(raw.goal, "goal"),
    process,
    agents,
    steps,
    approval: normalizeApproval(raw.approval),
    limits: isRecord(raw.limits) ? normalizeLimits(raw.limits) : undefined,
    tools: normalizeStringList(raw.tools),
    skills: normalizeStringList(raw.skills),
    memory: normalizeStringList(raw.memory),
    knowledge: normalizeStringList(raw.knowledge),
    scheduleIntent: optionalText(raw.scheduleIntent),
    channelIntent: optionalText(raw.channelIntent),
  };
  rejectUnsupportedRuntimeConcepts(recipe, raw);
  return recipe;
}

function normalizeProcess(raw: unknown): WorkflowRecipeProcess {
  const process = typeof raw === "string" ? raw.trim() : "sequential";
  if (process === "sequential" || process === "parallel" || process === "hierarchical") {
    return process;
  }
  throw new ValidationError({
    field: "process",
    message: "Supported recipe process modes are sequential, parallel, and hierarchical.",
  });
}

function normalizeAgents(raw: unknown): WorkflowRecipeAgent[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new ValidationError({ field: "agents", message: "Recipe requires at least one agent." });
  }
  return raw.map((agent, index) => {
    if (!isRecord(agent)) {
      throw new ValidationError({ field: `agents[${index}]`, message: "Agent must be an object." });
    }
    return {
      id: requireText(agent.id, `agents[${index}].id`),
      role: requireText(agent.role, `agents[${index}].role`),
      goal: optionalText(agent.goal),
      skills: normalizeStringList(agent.skills),
      tools: normalizeStringList(agent.tools),
    };
  });
}

function normalizeSteps(raw: unknown, agents: WorkflowRecipeAgent[]): WorkflowRecipeStep[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new ValidationError({ field: "steps", message: "Recipe requires at least one step." });
  }
  const agentIds = new Set(agents.map((agent) => agent.id));
  return raw.map((step, index) => {
    if (!isRecord(step)) {
      throw new ValidationError({ field: `steps[${index}]`, message: "Step must be an object." });
    }
    const agent = requireText(step.agent, `steps[${index}].agent`);
    if (!agentIds.has(agent)) {
      throw new ValidationError({
        field: `steps[${index}].agent`,
        message: `Step references unknown agent "${agent}".`,
      });
    }
    return {
      id: optionalText(step.id) ?? `step-${index + 1}`,
      title: requireText(step.title, `steps[${index}].title`),
      agent,
      prompt: requireText(step.prompt, `steps[${index}].prompt`),
      dependsOn: normalizeStringList(step.dependsOn),
      requiresApproval: typeof step.requiresApproval === "boolean" ? step.requiresApproval : undefined,
      tools: normalizeStringList(step.tools),
      skills: normalizeStringList(step.skills),
    };
  });
}

function normalizeApproval(raw: unknown): WorkflowRecipeApproval | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new ValidationError({ field: "approval", message: "approval must be an object." });
  }
  const mode = optionalText(raw.mode);
  if (mode && !["none", "before_run", "before_each_step", "on_sensitive_steps"].includes(mode)) {
    throw new ValidationError({ field: "approval.mode", message: "Unsupported approval mode." });
  }
  return {
    mode: mode as WorkflowRecipeApproval["mode"],
    requiredBeforeRun: typeof raw.requiredBeforeRun === "boolean" ? raw.requiredBeforeRun : undefined,
    requiredBeforeSteps: normalizeStringList(raw.requiredBeforeSteps),
  };
}

function normalizeLimits(raw: unknown): Required<WorkflowRecipeLimits> {
  const record = isRecord(raw) ? raw : {};
  return {
    maxIterations: normalizePositiveInteger(record.maxIterations, DEFAULT_LIMITS.maxIterations, "limits.maxIterations"),
    maxRuntimeMinutes: normalizePositiveInteger(
      record.maxRuntimeMinutes,
      DEFAULT_LIMITS.maxRuntimeMinutes,
      "limits.maxRuntimeMinutes",
    ),
    maxCostUsd: normalizePositiveNumber(record.maxCostUsd, DEFAULT_LIMITS.maxCostUsd, "limits.maxCostUsd"),
  };
}

function buildOrchestrationPlan(
  recipe: WorkflowRecipeRecord,
  limits: Required<WorkflowRecipeLimits>,
  requiredApprovals: string[],
): OrchestrationPlan {
  const slug = slugify(recipe.name);
  const phases = recipe.steps.map((step, index) => ({
    phaseId: step.id,
    ownerAgentId: step.agent,
    specPath: `recipe://${slug}/steps/${index + 1}-${slugify(step.title)}`,
    loopMode: "fresh-context" as const,
    requiresApproval: requiredApprovals.includes(step.id),
  }));
  const ownership = recipe.agents.map((agent) => ({
    agentId: agent.id,
    paths: ["workspace"],
  }));
  const baseWave = {
    waveId: "wave-1",
    verify: [],
    budgetUsd: limits.maxCostUsd,
    ownership,
    phases,
  };
  const waves =
    recipe.process === "hierarchical"
      ? [
          {
            ...baseWave,
            phases: [
              {
                phaseId: "coordinator-brief",
                ownerAgentId: recipe.agents[0]!.id,
                specPath: `recipe://${slug}/coordinator-brief`,
                loopMode: "fresh-context" as const,
                requiresApproval: requiredApprovals.includes("coordinator-brief"),
              },
              ...phases,
              {
                phaseId: "coordinator-synthesis",
                ownerAgentId: recipe.agents[0]!.id,
                specPath: `recipe://${slug}/coordinator-synthesis`,
                loopMode: "compaction" as const,
                requiresApproval: false,
              },
            ],
          },
        ]
      : [baseWave];
  return {
    planId: `recipe-${slug}-${hashRecipe(recipe).slice(0, 8)}`,
    goal: recipe.goal,
    mode: requiredApprovals.length > 0 ? "hitl" : "auto",
    maxIterations: limits.maxIterations,
    maxRuntimeMinutes: limits.maxRuntimeMinutes,
    maxCostUsd: limits.maxCostUsd,
    waves,
  };
}

function normalizeRequiredApprovals(recipe: WorkflowRecipeRecord): string[] {
  const approval = recipe.approval;
  if (!approval || approval.mode === "none") {
    return recipe.steps.filter((step) => step.requiresApproval).map((step) => step.id);
  }
  if (approval.requiredBeforeRun || approval.mode === "before_run") {
    return [
      ...(recipe.process === "hierarchical" ? ["coordinator-brief"] : []),
      ...recipe.steps.map((step) => step.id),
    ];
  }
  if (approval.mode === "before_each_step") {
    return recipe.steps.map((step) => step.id);
  }
  const explicit = new Set([
    ...(approval.requiredBeforeSteps ?? []),
    ...recipe.steps.filter((s) => s.requiresApproval).map((s) => s.id),
  ]);
  return Array.from(explicit);
}

function detectMissingSkills(recipe: WorkflowRecipeRecord, skills: SkillListItem[]): string[] {
  const known = new Set(skills.flatMap((skill) => [skill.skillId, skill.name]).map((value) => value.toLowerCase()));
  return collectRecipeRefs(recipe, "skills").filter((skill) => !known.has(skill.toLowerCase()));
}

function detectMissingTools(recipe: WorkflowRecipeRecord, tools: string[]): string[] {
  const known = new Set(tools.map((tool) => tool.toLowerCase()));
  if (known.size === 0) {
    return collectRecipeRefs(recipe, "tools");
  }
  return collectRecipeRefs(recipe, "tools").filter((tool) => !known.has(tool.toLowerCase()));
}

function collectRecipeRefs(recipe: WorkflowRecipeRecord, key: "tools" | "skills"): string[] {
  return Array.from(
    new Set([
      ...(recipe[key] ?? []),
      ...recipe.agents.flatMap((agent) => agent[key] ?? []),
      ...recipe.steps.flatMap((step) => step[key] ?? []),
    ]),
  );
}

function buildWarnings(recipe: WorkflowRecipeRecord): string[] {
  return [
    "Recipe preview creates an orchestration plan only; it does not execute a separate PraisonAI runtime.",
    ...(recipe.scheduleIntent ? ["scheduleIntent is recorded for review but does not auto-create an automation."] : []),
    ...(recipe.channelIntent ? ["channelIntent is recorded for review but does not auto-send messages."] : []),
    ...(recipe.process === "parallel"
      ? ["Parallel mode maps steps into one orchestration wave; durable run lifecycle remains unchanged."]
      : []),
  ];
}

function rejectUnsupportedRuntimeConcepts(recipe: WorkflowRecipeRecord, raw: Record<string, unknown>): void {
  const allTools = collectRecipeRefs(recipe, "tools");
  const unsupportedTool = allTools.find((tool) => /python|\.py\b|script|subprocess|shell/i.test(tool));
  if (unsupportedTool) {
    throw new ValidationError({
      field: "tools",
      message: `Unsupported recipe tool "${unsupportedTool}". V1 recipes cannot register arbitrary Python, shell, or external runtime tools.`,
    });
  }
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  const unsupportedAgent = agents.find(
    (agent) => isRecord(agent) && ("runtime" in agent || "allowCodeExecution" in agent || "externalAgent" in agent),
  );
  if (unsupportedAgent) {
    throw new ValidationError({
      field: "agents",
      message: "V1 recipes cannot declare external runtime agents or arbitrary code execution.",
    });
  }
}

function parseSimpleYaml(source: string): unknown {
  const root: Record<string, unknown> = {};
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  "))
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  const stack: Array<{ indent: number; container: Record<string, unknown> | unknown[] }> = [
    { indent: -1, container: root },
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const text = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!.container;
    if (text.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new ValidationError({ field: "source", message: `Invalid YAML list item at line ${index + 1}.` });
      }
      const itemText = text.slice(2).trim();
      if (itemText.includes(":")) {
        const item: Record<string, unknown> = {};
        parent.push(item);
        assignYamlKeyValue(item, itemText);
        stack.push({ indent, container: item });
      } else {
        parent.push(parseYamlScalar(itemText));
      }
      continue;
    }
    if (!isRecord(parent)) {
      throw new ValidationError({ field: "source", message: `Invalid YAML mapping at line ${index + 1}.` });
    }
    const { key, value } = splitYamlKeyValue(text, index + 1);
    if (value !== undefined) {
      parent[key] = parseYamlScalar(value);
      continue;
    }
    const next = lines.slice(index + 1).find((line) => line.trim());
    const nextText = next?.trim() ?? "";
    const child: Record<string, unknown> | unknown[] = nextText.startsWith("- ") ? [] : {};
    parent[key] = child;
    stack.push({ indent, container: child });
  }
  return root;
}

function assignYamlKeyValue(target: Record<string, unknown>, text: string): void {
  const { key, value } = splitYamlKeyValue(text, -1);
  target[key] = value === undefined ? {} : parseYamlScalar(value);
}

function splitYamlKeyValue(text: string, lineNumber: number): { key: string; value?: string } {
  const index = text.indexOf(":");
  if (index < 1) {
    throw new ValidationError({
      field: "source",
      message: lineNumber > 0 ? `Invalid YAML mapping at line ${lineNumber}.` : "Invalid YAML mapping.",
    });
  }
  const key = text.slice(0, index).trim();
  const value = text.slice(index + 1).trim();
  return { key, value: value.length ? value : undefined };
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => String(parseYamlScalar(item.trim())));
  }
  return trimmed;
}

function normalizeStringList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const normalized = Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
  return normalized.length ? normalized : undefined;
}

function requireText(raw: unknown, field: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return value;
}

function optionalText(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function normalizePositiveInteger(raw: unknown, fallback: number, field: string): number {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError({ field, message: `${field} must be a positive integer.` });
  }
  return value;
}

function normalizePositiveNumber(raw: unknown, fallback: number, field: string): number {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError({ field, message: `${field} must be a positive number.` });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "recipe"
  );
}

function hashRecipe(recipe: WorkflowRecipeRecord): string {
  return createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
}

const STARTER_TEMPLATES: WorkflowRecipeTemplateRecord[] = [
  template(
    "weekly-business-review",
    "Weekly business review",
    "Review the week, surface risks, and draft next actions.",
    ["Collect wins, misses, metrics, and open blockers.", "Synthesize decisions and next-week priorities."],
  ),
  template("customer-support-triage", "Customer support triage", "Classify support themes and recommend follow-ups.", [
    "Group recent support issues by severity and account impact.",
    "Draft escalation notes and response priorities.",
  ]),
  template("content-calendar", "Content calendar", "Plan a practical content calendar from goals and constraints.", [
    "Review audience, offers, deadlines, and channel constraints.",
    "Draft a calendar with owners, assets, and approval points.",
  ]),
  template("campaign-review", "Campaign review", "Review campaign results and propose concrete changes.", [
    "Compare channel performance against goals.",
    "Identify next experiments and stop/continue decisions.",
  ]),
  template("rice-roadmap", "Product roadmap RICE prioritization", "Score roadmap items with RICE-style reasoning.", [
    "Normalize candidate items and assumptions.",
    "Score reach, impact, confidence, and effort with caveats.",
  ]),
  template("customer-health-revops", "Customer health and revenue ops", "Summarize account health and revenue risk.", [
    "Review renewal, usage, blockers, and sentiment signals.",
    "Prioritize outreach and risk mitigation.",
  ]),
  template("chief-of-staff-daily-brief", "Chief-of-staff daily brief", "Create a concise operator brief for the day.", [
    "Collect schedule, urgent decisions, and open loops.",
    "Draft a brief with priorities, risks, and approvals.",
  ]),
  template("deep-research-brief", "Deep research brief", "Produce a sourced research brief with synthesis caveats.", [
    "Collect source evidence, confidence labels, and unresolved questions.",
    "Synthesize findings, cite provenance, and flag claims needing operator judgment.",
  ]),
  template(
    "scheduled-monitor-review",
    "Scheduled monitor review",
    "Review a recurring monitor and recommend governed follow-up actions.",
    [
      "Inspect latest monitor signals, failures, and drift from expected thresholds.",
      "Summarize action candidates, approval needs, and safe next checks.",
    ],
  ),
  template(
    "morning-operator-digest",
    "Morning operator digest",
    "Create a daily operator digest from runtime, schedule, memory, and approval signals.",
    [
      "Gather overnight activity, pending approvals, schedule pressure, and runtime warnings.",
      "Draft a concise digest with priorities, blockers, and decisions due today.",
    ],
  ),
  template(
    "code-assistant-proof-loop",
    "Code assistant proof loop",
    "Plan a code change with focused implementation and validation evidence.",
    [
      "Read the relevant code owner, current implementation, and user-facing contract.",
      "Define the smallest patch, focused tests, and proof lane before implementation.",
    ],
  ),
];

function template(
  templateId: string,
  name: string,
  description: string,
  stepPrompts: string[],
): WorkflowRecipeTemplateRecord {
  return {
    templateId,
    name,
    description,
    recipe: {
      name,
      goal: description,
      process: "sequential",
      agents: [
        {
          id: "coordinator",
          role: "Coordinator",
          goal: "Keep the work focused, truthful, and actionable.",
        },
        {
          id: "analyst",
          role: "Analyst",
          goal: "Review evidence and produce structured findings.",
        },
      ],
      steps: stepPrompts.map((prompt, index) => ({
        id: `step-${index + 1}`,
        title: index === 0 ? "Gather context" : "Synthesize actions",
        agent: index === 0 ? "analyst" : "coordinator",
        prompt,
        requiresApproval: index === stepPrompts.length - 1,
      })),
      approval: {
        mode: "on_sensitive_steps",
      },
      limits: DEFAULT_LIMITS,
    },
  };
}
