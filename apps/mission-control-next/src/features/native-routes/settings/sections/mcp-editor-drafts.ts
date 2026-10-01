import type { McpServerRecord, McpServerTemplateRecord } from "@goatcitadel/contracts";

export function createEmptyMcpCreateForm() {
  return {
    label: "",
    transport: "stdio" as McpServerRecord["transport"],
    command: "",
    args: [] as string[],
    url: "",
    authType: "none" as McpServerRecord["authType"],
    oauth: undefined as McpServerRecord["oauth"] | undefined,
    enabled: true,
    category: "development" as McpServerRecord["category"],
    trustTier: "restricted" as McpServerRecord["trustTier"],
    costTier: "unknown" as McpServerRecord["costTier"],
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
      allowedEnvKeys: [],
    } as McpServerRecord["policy"],
  };
}
export type McpCreateForm = ReturnType<typeof createEmptyMcpCreateForm>;

/** Keep the full advertised template configuration visible in the retained draft. */
export function createMcpFormFromTemplate(template: McpServerTemplateRecord): McpCreateForm {
  return {
    ...createEmptyMcpCreateForm(),
    label: template.label,
    transport: template.transport,
    command: template.command ?? "",
    args: [...(template.args ?? [])],
    url: template.url ?? "",
    authType: template.authType,
    oauth: template.oauth ? structuredClone(template.oauth) : undefined,
    enabled: template.enabledByDefault,
    category: template.category,
    trustTier: template.trustTier,
    costTier: template.costTier,
    policy: structuredClone(template.policy),
  };
}

export function createMcpEditForm(server: McpServerRecord | null) {
  return {
    label: server?.label ?? "",
    command: server?.command ?? "",
    url: server?.url ?? "",
    enabled: server?.enabled ?? true,
    category: server?.category ?? "development",
    args: [...(server?.args ?? [])],
    policy: structuredClone(server?.policy ?? createEmptyMcpCreateForm().policy),
  };
}
