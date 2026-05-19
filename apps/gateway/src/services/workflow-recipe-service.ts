import { createHash } from "node:crypto";
import type {
  OrchestrationPlan,
  OrchestrationRun,
  OrchestrationRunPolicyContext,
  SkillListItem,
  WorkflowRecipeAgent,
  WorkflowRecipeApproval,
  WorkflowRecipeLimits,
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
