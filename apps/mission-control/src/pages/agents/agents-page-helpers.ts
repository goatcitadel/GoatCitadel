import type { AgentsResponse } from "../../api/client";

export interface AgentFormState {
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialtiesText: string;
  defaultToolsText: string;
  aliasesText: string;
  presetLabel: string;
  presetSummary: string;
  presetRouteHint: "" | "chat" | "cowork" | "code";
  presetProviderId: string;
  presetModel: string;
  presetToolsPosture: "" | "safe_auto" | "manual";
  presetKnowledgeAttachmentsText: string;
  presetPromptFraming: string;
}

export function emptyForm(): AgentFormState {
  return {
    roleId: "",
    name: "",
    title: "",
    summary: "",
    specialtiesText: "",
    defaultToolsText: "",
    aliasesText: "",
    presetLabel: "",
    presetSummary: "",
    presetRouteHint: "",
    presetProviderId: "",
    presetModel: "",
    presetToolsPosture: "",
    presetKnowledgeAttachmentsText: "",
    presetPromptFraming: "",
  };
}

export function formFromAgent(agent: AgentsResponse["items"][number]): AgentFormState {
  return {
    roleId: agent.roleId,
    name: agent.name,
    title: agent.title,
    summary: agent.summary,
    specialtiesText: agent.specialties.join("\n"),
    defaultToolsText: agent.defaultTools.join("\n"),
    aliasesText: agent.aliases.join("\n"),
    presetLabel: agent.presetDefaults?.presetLabel ?? "",
    presetSummary: agent.presetDefaults?.presetSummary ?? "",
    presetRouteHint: agent.presetDefaults?.routeHint ?? "",
    presetProviderId: agent.presetDefaults?.preferredProviderId ?? "",
    presetModel: agent.presetDefaults?.preferredModel ?? "",
    presetToolsPosture: agent.presetDefaults?.toolsPosture ?? "",
    presetKnowledgeAttachmentsText: (agent.presetDefaults?.knowledgeAttachmentIds ?? []).join("\n"),
    presetPromptFraming: agent.presetDefaults?.promptFraming ?? "",
  };
}

export function splitMultiline(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/g)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function normalizeRoleIdCandidate(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 80);
}

export function hasAdvancedPresetDefaults(form: AgentFormState): boolean {
  return Boolean(
    form.presetProviderId.trim() ||
    form.presetModel.trim() ||
    form.presetToolsPosture ||
    form.presetKnowledgeAttachmentsText.trim() ||
    form.presetPromptFraming.trim(),
  );
}

export function buildPresetDefaultsFromForm(form: AgentFormState) {
  const knowledgeAttachmentIds = splitMultiline(form.presetKnowledgeAttachmentsText);
  const presetDefaults = {
    presetLabel: form.presetLabel.trim() || undefined,
    presetSummary: form.presetSummary.trim() || undefined,
    routeHint: form.presetRouteHint || undefined,
    preferredProviderId: form.presetProviderId.trim() || undefined,
    preferredModel: form.presetModel.trim() || undefined,
    toolsPosture: form.presetToolsPosture || undefined,
    knowledgeAttachmentIds: knowledgeAttachmentIds.length > 0 ? knowledgeAttachmentIds : undefined,
    promptFraming: form.presetPromptFraming.trim() || undefined,
  };
  return Object.values(presetDefaults).some((value) => value !== undefined) ? presetDefaults : undefined;
}

export function buildFormChanges(
  current: AgentFormState,
  baseline: AgentFormState,
): Array<{ field: string; from: unknown; to: unknown }> {
  const entries: Array<{ field: keyof AgentFormState; label: string }> = [
    { field: "roleId", label: "roleId" },
    { field: "name", label: "name" },
    { field: "title", label: "title" },
    { field: "summary", label: "summary" },
    { field: "specialtiesText", label: "specialties" },
    { field: "defaultToolsText", label: "defaultTools" },
    { field: "aliasesText", label: "aliases" },
    { field: "presetLabel", label: "presetLabel" },
    { field: "presetSummary", label: "presetSummary" },
    { field: "presetRouteHint", label: "presetRouteHint" },
    { field: "presetProviderId", label: "preferredProviderId" },
    { field: "presetModel", label: "preferredModel" },
    { field: "presetToolsPosture", label: "toolsPosture" },
    { field: "presetKnowledgeAttachmentsText", label: "knowledgeAttachmentIds" },
    { field: "presetPromptFraming", label: "promptFraming" },
  ];

  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const entry of entries) {
    if (current[entry.field] === baseline[entry.field]) {
      continue;
    }
    changes.push({
      field: entry.label,
      from: baseline[entry.field],
      to: current[entry.field],
    });
  }
  return changes;
}
