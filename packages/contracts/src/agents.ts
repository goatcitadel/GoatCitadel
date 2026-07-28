import type { ChatMode } from "./chat.js";
import type { RunVariableBindings, RunVariableSchema } from "./run-variables.js";

export type AgentRuntimeStatus = "active" | "idle";
export type AgentLifecycleStatus = "active" | "archived";
export type RichAgentSourceProvider = "agency_agents" | "manual" | "workspace";
export type RichAgentParseSupportStatus = "supported" | "supported_with_warnings" | "unsupported";
export type ImportedAgentCatalogLifecycleStatus = "disabled" | "approved" | "active" | "retired";
export type RichAgentSectionKind = "persona" | "operations" | "reference" | "other";

export interface AgentPresetDefaults {
  presetLabel?: string;
  presetSummary?: string;
  routeHint?: ChatMode;
  preferredProviderId?: string;
  preferredModel?: string;
  toolsPosture?: "safe_auto" | "manual";
  knowledgeAttachmentIds?: string[];
  promptFraming?: string;
  runVariableSchema?: RunVariableSchema;
  runVariableDefaults?: RunVariableBindings;
}

export interface AgentProfileRecord {
  agentId: string;
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties: string[];
  defaultTools: string[];
  aliases: string[];
  isBuiltin: boolean;
  editable: boolean;
  lifecycleStatus: AgentLifecycleStatus;
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
  presetDefaults?: AgentPresetDefaults;
  richDefinitionId?: string;
  richDefinitionParseStatus?: RichAgentParseSupportStatus;
  richDefinitionSource?: RichAgentSourceProvider;
  status: AgentRuntimeStatus;
  sessionCount: number;
  activeSessions: number;
  lastUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileCreateInput {
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties?: string[];
  defaultTools?: string[];
  aliases?: string[];
  presetDefaults?: AgentPresetDefaults;
}

export interface AgentProfileUpdateInput {
  name?: string;
  title?: string;
  summary?: string;
  specialties?: string[];
  defaultTools?: string[];
  aliases?: string[];
  presetDefaults?: AgentPresetDefaults;
}

export interface AgentProfileArchiveInput {
  archivedBy?: string;
  archiveReason?: string;
}

export interface BuiltinAgentProfileSeed {
  agentId: string;
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties: string[];
  defaultTools: string[];
  aliases: string[];
  presetDefaults?: AgentPresetDefaults;
}

export interface RichAgentFrontmatter {
  name: string;
  description: string;
  color?: string;
  services?: string[];
  presentation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface RichAgentSectionRecord {
  key: string;
  slug: string;
  heading: string;
  level: number;
  kind: RichAgentSectionKind;
  content: string;
  canonicalKey?: string;
}

export type RichAgentSectionMap = Record<string, RichAgentSectionRecord>;

export interface RichAgentSourceProvenance {
  provider: RichAgentSourceProvider;
  repoUrl?: string;
  ref?: string;
  commit?: string;
  path: string;
  sha256: string;
  importedAt: string;
}

export interface RichAgentDefinitionRecord {
  definitionId: string;
  slug: string;
  frontmatter: RichAgentFrontmatter;
  rawMarkdown: string;
  bodyMarkdown: string;
  sectionOrder: string[];
  sectionMap: RichAgentSectionMap;
  parseStatus: RichAgentParseSupportStatus;
  parseWarnings: string[];
  provenance: RichAgentSourceProvenance;
}

export interface ImportedAgentCatalogRecord {
  entryId: string;
  workspaceId: string;
  division: string;
  state: ImportedAgentCatalogLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  retiredAt?: string;
  definition: RichAgentDefinitionRecord;
}

export interface ImportedAgentCatalogListInput {
  workspaceId?: string;
  division?: string;
  search?: string;
  state?: ImportedAgentCatalogLifecycleStatus | "all";
  parseStatus?: RichAgentParseSupportStatus | "all";
  limit?: number;
}

export interface ImportedAgentCatalogStatePatchInput {
  state: ImportedAgentCatalogLifecycleStatus;
}

export interface AgencyCatalogImportRequest {
  workspaceId?: string;
  repoUrl?: string;
  ref?: string;
}

export interface AgencyCatalogImportResponse {
  workspaceId: string;
  repoUrl: string;
  ref: string;
  commit?: string;
  importedAt: string;
  importedCount: number;
  divisions: string[];
  parseCounts: Record<RichAgentParseSupportStatus, number>;
}

export interface CatalogSessionActivationRequest {
  sessionId: string;
}

export const BUILTIN_AGENT_PROFILES: BuiltinAgentProfileSeed[] = [
  {
    agentId: "builtin-architect",
    roleId: "architect",
    name: "Architect Goat",
    title: "Systems Architect",
    summary: "Designs system boundaries, contracts, and sequencing decisions.",
    specialties: ["Architecture", "APIs", "Tradeoffs"],
    defaultTools: ["session.status", "memory.read", "fs.read", "browser.search"],
    aliases: ["architect", "system architect", "staff engineer"],
  },
  {
    agentId: "builtin-coder",
    roleId: "coder",
    name: "Coder Goat",
    title: "Implementation Engineer",
    summary: "Implements features, refactors safely, and keeps delivery moving.",
    specialties: ["TypeScript", "Refactors", "Integration"],
    defaultTools: ["fs.read", "fs.write", "shell.exec", "git.exec"],
    aliases: ["coder", "developer", "implementation", "engineer"],
    presetDefaults: {
      presetLabel: "Code Helper",
      presetSummary: "Fast implementation help with stricter apply posture and code-first framing.",
      routeHint: "code",
      toolsPosture: "manual",
      promptFraming:
        "Act as a code helper. Preserve project patterns, explain tradeoffs briefly, and keep diffs reviewable.",
    },
  },
  {
    agentId: "builtin-qa",
    roleId: "qa",
    name: "QA Goat",
    title: "Verification Lead",
    summary: "Finds regressions early, validates acceptance criteria, and hardens behavior.",
    specialties: ["Testing", "Edge cases", "Regression checks"],
    defaultTools: ["shell.exec", "fs.read", "memory.read"],
    aliases: ["qa", "quality", "tester", "verification"],
    presetDefaults: {
      presetLabel: "Reviewer",
      presetSummary: "Review-focused posture that emphasizes regressions, risks, and missing tests.",
      routeHint: "code",
      toolsPosture: "manual",
      promptFraming:
        "Review this work for bugs, regressions, risky assumptions, and missing tests before suggesting polish.",
    },
  },
  {
    agentId: "builtin-researcher",
    roleId: "researcher",
    name: "Researcher Goat",
    title: "Research Analyst",
    summary: "Gathers primary-source facts, compares options, and summarizes decisions.",
    specialties: ["Discovery", "Comparative analysis", "Sourcing"],
    defaultTools: ["browser.search", "http.get", "citations.build"],
    aliases: ["researcher", "research", "analyst"],
    presetDefaults: {
      presetLabel: "Researcher",
      presetSummary: "Source-backed research posture with synthesis, citations, and broader comparison depth.",
      routeHint: "cowork",
      toolsPosture: "safe_auto",
      promptFraming:
        "Research this using primary sources where possible, synthesize the findings, and surface uncertainty clearly.",
    },
  },
  {
    agentId: "builtin-assistant",
    roleId: "assistant",
    name: "Personal Assistant Goat",
    title: "Operations Assistant",
    summary: "Handles routine organization, reminders, and operator-facing workflows.",
    specialties: ["Coordination", "Summaries", "Ops support"],
    defaultTools: ["session.status", "memory.read", "http.get"],
    aliases: ["assistant", "personal assistant", "pa", "operator assistant"],
  },
  {
    agentId: "builtin-memory-maintainer",
    roleId: "memory_maintainer",
    name: "Memory Maintainer",
    title: "Memory Maintainer",
    summary: "Keeps durable workspace memory tidy, scoped, and operator-trustworthy.",
    specialties: ["Memory curation", "Source attribution", "Context hygiene"],
    defaultTools: ["memory.read", "memory.write", "session.status"],
    aliases: ["memory maintainer", "memory curator", "context keeper"],
    presetDefaults: {
      presetLabel: "Memory Maintainer",
      presetSummary: "Curate, reconcile, and sharpen memory without silently broadening its scope.",
      routeHint: "chat",
      toolsPosture: "safe_auto",
      promptFraming:
        "Curate the relevant memory for this workspace, preserve decisions and provenance, and avoid promoting uncertain facts.",
    },
  },
  {
    agentId: "builtin-product",
    roleId: "product",
    name: "Product Goat",
    title: "Product Strategist",
    summary: "Turns user goals into scoped deliverables and measurable milestones.",
    specialties: ["Scoping", "Prioritization", "Roadmaps"],
    defaultTools: ["memory.read", "browser.search"],
    aliases: ["product", "pm", "product manager", "planner"],
  },
  {
    agentId: "builtin-ops",
    roleId: "ops",
    name: "Ops Goat",
    title: "Runtime Operator",
    summary: "Monitors runtime health, safety posture, and operational constraints.",
    specialties: ["Reliability", "Safety", "Incident response"],
    defaultTools: ["session.status", "http.get", "shell.exec"],
    aliases: ["ops", "sre", "operations", "infra"],
  },
];
