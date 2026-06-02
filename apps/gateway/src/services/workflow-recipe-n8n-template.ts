import type {
  WorkflowRecipeActivepiecesTemplateValidationCheck,
  WorkflowRecipeN8nTemplateExportRequest,
  WorkflowRecipeN8nTemplateValidation,
  WorkflowRecipeN8nWorkflowTemplate,
  WorkflowRecipePreviewResponse,
} from "@goatcitadel/contracts";

export function validateN8nTemplateExport(
  template: WorkflowRecipeN8nWorkflowTemplate,
): WorkflowRecipeN8nTemplateValidation {
  const webhook = template.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  const checks: WorkflowRecipeActivepiecesTemplateValidationCheck[] = [
    webhook && typeof webhook.parameters.path === "string" && webhook.parameters.path.length > 0
      ? {
          id: "webhook-trigger",
          label: "Webhook trigger",
          status: "passed",
          detail: "Workflow declares a webhook path for operator import review.",
        }
      : {
          id: "webhook-trigger",
          label: "Webhook trigger",
          status: "blocked",
          detail: "n8n export requires a non-empty webhook path.",
        },
    template.nodes.length > 1
      ? {
          id: "step-plan",
          label: "Step plan",
          status: "passed",
          detail: `${template.nodes.length - 1} GoatCitadel review node${template.nodes.length === 2 ? "" : "s"} included as planning metadata.`,
        }
      : {
          id: "step-plan",
          label: "Step plan",
          status: "warning",
          detail: "No recipe-step nodes were included; operator import would create trigger-only planning evidence.",
        },
    buildN8nStepGraphCheck(template),
    {
      id: "execution-posture",
      label: "Execution posture",
      status: "passed",
      detail:
        "Export contains prompts and metadata only; it does not create a workflow, call a webhook, poll, or run tools.",
    },
    {
      id: "native-n8n-import",
      label: "Native n8n import",
      status: "warning",
      detail: "Native n8n import-schema compatibility has not been verified by GoatCitadel.",
    },
  ];
  return {
    status: checks.some((check) => check.status === "blocked") ? "blocked" : "ready_for_operator_import_review",
    nativeImportCompatibility: "not_verified",
    checks,
    notes: [
      "Use this JSON as operator-import planning evidence, then validate it inside n8n before enabling a workflow.",
      "GoatCitadel does not poll n8n or manage n8n workflow lifecycle from this export.",
    ],
  };
}

export function buildN8nWorkflowTemplate(
  preview: WorkflowRecipePreviewResponse,
  input: WorkflowRecipeN8nTemplateExportRequest,
): WorkflowRecipeN8nWorkflowTemplate {
  const recipe = preview.recipe;
  const workflowName = optionalText(input.workflowName) ?? `${recipe.name} - GoatCitadel review`;
  const webhookPath = optionalText(input.webhookPath) ?? `goatcitadel-${slugify(recipe.name)}`;
  const webhookNode = {
    id: "goatcitadel-webhook",
    name: "GoatCitadel operator import webhook",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [0, 0] as [number, number],
    parameters: {
      httpMethod: "POST",
      path: webhookPath.replace(/^\/+/, ""),
      responseMode: "onReceived",
    },
    notes: "Operator import review only. GoatCitadel does not create this webhook or call it.",
  };
  const stepNodes = recipe.steps.map((step, index) => ({
    id: `goatcitadel-step-${sanitizeRecipeNodeId(step.id)}`,
    name: `${index + 1}. ${step.title}`,
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [320 + index * 260, index % 2 === 0 ? 0 : 160] as [number, number],
    parameters: {
      goatcitadel: {
        stepId: step.id,
        agent: step.agent,
        prompt: step.prompt,
        requiresApproval: preview.requiredApprovals.includes(step.id) || step.requiresApproval === true,
        dependsOn: step.dependsOn ?? [],
        tools: step.tools ?? [],
        skills: step.skills ?? [],
      },
    },
    notes: step.prompt,
  }));
  const nodes = [webhookNode, ...stepNodes];
  const connections: WorkflowRecipeN8nWorkflowTemplate["connections"] = {};
  for (let index = 0; index < nodes.length - 1; index += 1) {
    connections[nodes[index]!.name] = {
      main: [[{ node: nodes[index + 1]!.name, type: "main", index: 0 }]],
    };
  }
  return {
    name: workflowName,
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      saveManualExecutions: true,
    },
    meta: {
      source: "goatcitadel.workflow_recipe",
      planId: preview.plan.planId,
      approvalMode: preview.requiredApprovals.length > 0 ? "human_in_the_loop" : "none",
      ...(recipe.scheduleIntent ? { scheduleIntent: recipe.scheduleIntent } : {}),
      ...(recipe.channelIntent ? { channelIntent: recipe.channelIntent } : {}),
    },
  };
}

function buildN8nStepGraphCheck(
  template: WorkflowRecipeN8nWorkflowTemplate,
): WorkflowRecipeActivepiecesTemplateValidationCheck {
  const nodeNames = new Set(template.nodes.map((node) => node.name));
  const danglingConnections = new Set<string>();
  for (const [sourceName, outputs] of Object.entries(template.connections)) {
    if (!nodeNames.has(sourceName)) {
      danglingConnections.add(sourceName);
    }
    for (const groups of Object.values(outputs)) {
      for (const group of groups) {
        for (const edge of group) {
          if (!nodeNames.has(edge.node)) {
            danglingConnections.add(`${sourceName}->${edge.node}`);
          }
        }
      }
    }
  }
  if (danglingConnections.size === 0) {
    return {
      id: "step-graph",
      label: "Step graph",
      status: "passed",
      detail: "All n8n node connection references resolve inside the exported planning template.",
    };
  }
  return {
    id: "step-graph",
    label: "Step graph",
    status: "blocked",
    detail: `Dangling n8n connection references: ${Array.from(danglingConnections).slice(0, 5).join(", ")}.`,
  };
}

function optionalText(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function sanitizeRecipeNodeId(value: string): string {
  return slugify(value).replace(/[^a-z0-9-]/g, "") || "step";
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
