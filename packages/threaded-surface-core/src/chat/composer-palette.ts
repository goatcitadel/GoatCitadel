export type ComposerPaletteSourceId =
  | "commands"
  | "models"
  | "agents"
  | "skills"
  | "projects"
  | "files"
  | "knowledge"
  | "urls"
  | "external_sources"
  | "prompt_packs"
  | "documents";

export type ComposerPaletteMode = "commands" | "context" | "skills" | "all";

export type ComposerPaletteAction =
  | { type: "insert_command"; value: string }
  | { type: "select_model"; providerId: string; model: string }
  | { type: "select_preset"; agentId: string }
  | { type: "switch_project"; projectId: string; projectName: string }
  | { type: "attach_file"; relativePath: string }
  | { type: "attach_context"; attachmentId: string }
  | {
      type: "attach_document";
      documentKind: "personal_note" | "generated_artifact";
      documentId: string;
      label: string;
    }
  | { type: "attach_url"; url: string }
  | { type: "launch_external_source" }
  | { type: "explore_workspace" }
  | {
      type: "open_template_form";
      invocation: Omit<import("@goatcitadel/contracts").RunTemplateInvocation, "values">;
      schema: import("@goatcitadel/contracts").RunVariableSchema;
      template: string;
      defaults?: import("@goatcitadel/contracts").RunVariableBindings;
    };

export interface ComposerPaletteItem {
  key: string;
  command: string;
  description: string;
  applyValue: string;
  source: ComposerPaletteSourceId;
  sourceLabel: string;
  availabilityLabel: string;
  action: ComposerPaletteAction;
  keywords?: string[];
}

export interface ComposerPaletteSourceFailure {
  source: ComposerPaletteSourceId;
  sourceLabel: string;
  message: string;
}

export interface ComposerPaletteSearchResult {
  items: ComposerPaletteItem[];
  failures: ComposerPaletteSourceFailure[];
}

export interface ComposerPaletteSourceContext {
  sessionKey: string;
  workspaceId: string;
}

export interface ComposerPaletteSourceDefinition {
  id: ComposerPaletteSourceId;
  label: string;
  load: (context: ComposerPaletteSourceContext) => Promise<ComposerPaletteItem[]> | ComposerPaletteItem[];
}

export interface ComposerPaletteSearchInput extends ComposerPaletteSourceContext {
  mode: ComposerPaletteMode;
  query: string;
  limit?: number;
}

export function detectComposerPaletteTrigger(draft: string): { mode: ComposerPaletteMode; query: string } | null {
  const slashMatch = draft.trimStart().match(/^\/([^\n]*)$/u);
  if (slashMatch) return { mode: "commands", query: slashMatch[1]?.trim() ?? "" };

  const tokenMatch = draft.match(/(?:^|\s)([@$])([^\s]*)$/u);
  if (!tokenMatch) return null;
  return {
    mode: tokenMatch[1] === "$" ? "skills" : "context",
    query: tokenMatch[2] ?? "",
  };
}

export {
  ComposerPaletteSourceRegistry,
  rankComposerPaletteItems,
  createUrlPaletteItem,
} from "./composer-palette-search-code.js";
